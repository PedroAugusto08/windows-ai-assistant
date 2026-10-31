//! Interpretation only: this module has no task store, app handle, or execution tools.
use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

const MODEL: &str = "gemini-3.5-flash-lite";
const ENDPOINT: &str =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";
const INVALID: &str = "Resposta de interpretação inválida. Nenhuma ação executada.";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    CreateTask,
    QueryTasks,
    UpdateTask,
    CompleteTask,
    DeleteTask,
    OpenPanel,
    Conversation,
    Clarify,
    Unsupported,
    AcceptSuggestion,
    DeclineSuggestion,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    Normal,
    High,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Panel {
    Tasks,
    Agenda,
    Chat,
    System,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Parameters {
    pub title: Option<String>,
    pub title_suffix: Option<String>,
    pub restore_fields: Option<Vec<String>>,
    pub status: Option<String>,
    pub query_period: Option<String>,
    pub priority: Option<Priority>,
    pub project: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub target: Option<String>,
    pub panel: Option<Panel>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Interpretation {
    pub intent: Intent,
    pub parameters: Parameters,
    pub reply: String,
    pub clarification: Option<String>,
    pub requires_confirmation: bool,
    pub uses_previous_draft: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub message: String,
    pub context: Vec<String>,
    pub previous_draft: Option<Parameters>,
    #[serde(default)]
    pub previous_task: bool,
    #[serde(default)]
    pub pending_suggestion: Option<String>,
    #[serde(default)]
    pub query_anchor: Option<String>,
    #[serde(default)]
    pub restorable_fields: Vec<String>,
    pub local_now: String,
    pub time_zone: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub interpretation: Interpretation,
    pub dry_run: bool,
    pub executed: bool,
    pub model: &'static str,
    pub latency_ms: u128,
    pub request_count: u32,
    pub prompt_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntelligenceError {
    pub code: &'static str,
    pub message: &'static str,
    pub retry_after_seconds: Option<u64>,
}
fn error(code: &'static str, message: &'static str) -> IntelligenceError {
    IntelligenceError {
        code,
        message,
        retry_after_seconds: None,
    }
}
fn invalid() -> IntelligenceError {
    error("invalid_response", INVALID)
}

#[derive(Default)]
pub struct IntelligenceState {
    gate: Mutex<Gate>,
}
#[derive(Default)]
struct Gate {
    busy: bool,
    count: u32,
    next: Option<Instant>,
}
impl Gate {
    fn reserve(&mut self, now: Instant) -> Result<u32, IntelligenceError> {
        if self.busy {
            return Err(error("busy", "Já há uma interpretação em andamento."));
        }
        if self.count >= 20 {
            return Err(error(
                "session_limit",
                "Limite de 20 chamadas por sessão atingido. Nenhuma ação executada.",
            ));
        }
        if let Some(next) = self.next.filter(|next| *next > now) {
            return Err(IntelligenceError {
                code: "rate_limit",
                message: "Aguarde antes de enviar outro comando.",
                retry_after_seconds: Some((next - now).as_secs() + 1),
            });
        }
        self.busy = true;
        self.count += 1;
        self.next = Some(now + Duration::from_secs(6));
        Ok(self.count)
    }
}

fn validate_parameters(p: &Parameters) -> Result<(), IntelligenceError> {
    if p.query_period.as_deref().is_some_and(|s| {
        ![
            "today",
            "tomorrow",
            "this_week",
            "next_week",
            "week_of_date",
        ]
        .contains(&s)
    }) {
        return Err(invalid());
    }
    if p.query_period.as_deref() == Some("week_of_date") && p.due_date.is_none() {
        return Err(invalid());
    }
    if p.status
        .as_deref()
        .is_some_and(|s| !["pending", "completed", "all", "overdue"].contains(&s))
    {
        return Err(invalid());
    }
    for value in [&p.title, &p.title_suffix, &p.project, &p.target] {
        if value
            .as_ref()
            .is_some_and(|s| s.trim().is_empty() || s.chars().count() > 200)
        {
            return Err(invalid());
        }
    }
    if p.title.is_some() && p.title_suffix.is_some() {
        return Err(invalid());
    }
    if let Some(fields) = &p.restore_fields {
        if fields.is_empty()
            || fields.len() > 5
            || fields.iter().enumerate().any(|(index, field)| {
                !["title", "project", "priority", "dueDate", "dueTime"].contains(&field.as_str())
                    || fields[..index].contains(field)
            })
        {
            return Err(invalid());
        }
    }
    if let Some(date) = &p.due_date {
        if date.len() != 10 || NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
            return Err(invalid());
        }
    }
    if let Some(time) = &p.due_time {
        if time.len() != 5 || NaiveTime::parse_from_str(time, "%H:%M").is_err() {
            return Err(invalid());
        }
    }
    Ok(())
}
fn validate_request(r: &Request) -> Result<(), IntelligenceError> {
    let now = DateTime::parse_from_rfc3339(&r.local_now)
        .map_err(|_| error("invalid_input", "Data local inválida."))?;
    if (Utc::now() - now.with_timezone(&Utc))
        .num_seconds()
        .unsigned_abs()
        > 120
        || r.message.trim().is_empty()
        || r.message.chars().count() > 1000
        || r.context.len() > 6
        || r.context.iter().any(|s| s.chars().count() > 1000)
        || r.time_zone.is_empty()
        || r.time_zone.len() > 100
    {
        return Err(error(
            "invalid_input",
            "Mensagem ou contexto fora dos limites da PoC.",
        ));
    }
    if r.pending_suggestion
        .as_deref()
        .is_some_and(|s| !["priority", "panel"].contains(&s))
    {
        return Err(error("invalid_input", "Sugestão fora do contrato."));
    }
    if let Some(anchor) = &r.query_anchor {
        if anchor.len() != 10 || NaiveDate::parse_from_str(anchor, "%Y-%m-%d").is_err() {
            return Err(error("invalid_input", "Referência temporal inválida."));
        }
    }
    if r.restorable_fields.len() > 5
        || r.restorable_fields.iter().any(|field| {
            !["title", "project", "priority", "dueDate", "dueTime"].contains(&field.as_str())
        })
    {
        return Err(error("invalid_input", "Campos de restauração inválidos."));
    }
    if let Some(p) = &r.previous_draft {
        validate_parameters(p)?;
    }
    Ok(())
}
fn request_body(r: &Request) -> Value {
    json!({
        "systemInstruction": {"parts": [{"text": include_str!("../../intelligence/prompt.txt")}]},
        "contents": [{"role": "user", "parts": [{"text": serde_json::to_string(r).expect("serializable request")}]}],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 2048,
            "responseMimeType": "application/json", "responseJsonSchema": serde_json::from_str::<Value>(include_str!("../../intelligence/schema.json")).expect("static schema")}
    })
}
fn parse_response(value: &Value, r: &Request) -> Result<Interpretation, IntelligenceError> {
    let candidate = value
        .get("candidates")
        .and_then(Value::as_array)
        .filter(|a| a.len() == 1)
        .and_then(|a| a.first())
        .ok_or_else(invalid)?;
    if candidate["finishReason"] != "STOP" {
        return Err(error(
            "blocked_response",
            "Resposta bloqueada ou incompleta. Nenhuma ação executada.",
        ));
    }
    let parts = candidate["content"]["parts"]
        .as_array()
        .ok_or_else(invalid)?;
    let text: String = parts
        .iter()
        .filter(|p| p["thought"] != true)
        .filter_map(|p| p["text"].as_str())
        .collect();
    if text.len() > 16000 {
        return Err(invalid());
    }
    let decoded: Value = serde_json::from_str(&text).map_err(|_| invalid())?;
    let schema: Value = serde_json::from_str(include_str!("../../intelligence/schema.json"))
        .expect("static schema");
    // Option fields must be explicitly null, not silently absent.
    for (object, required) in [
        (&decoded, &schema["required"]),
        (
            &decoded["parameters"],
            &schema["properties"]["parameters"]["required"],
        ),
    ] {
        if !required
            .as_array()
            .expect("schema required fields")
            .iter()
            .all(|key| object.get(key.as_str().expect("schema key")).is_some())
        {
            return Err(invalid());
        }
    }
    let mut interpretation: Interpretation =
        serde_json::from_value(decoded).map_err(|_| invalid())?;
    validate_parameters(&interpretation.parameters)?;
    if interpretation.reply.trim().is_empty()
        || interpretation.reply.chars().count() > 1000
        || interpretation
            .clarification
            .as_ref()
            .is_some_and(|s| s.trim().is_empty() || s.chars().count() > 500)
        || (interpretation.uses_previous_draft
            && (r.previous_draft.is_none() || interpretation.intent != Intent::CreateTask))
    {
        return Err(invalid());
    }
    if interpretation.parameters.query_period.as_deref() == Some("week_of_date")
        && interpretation.intent != Intent::QueryTasks
    {
        return Err(invalid());
    }
    if (interpretation.parameters.title_suffix.is_some()
        || interpretation.parameters.restore_fields.is_some())
        && interpretation.intent != Intent::UpdateTask
    {
        return Err(invalid());
    }
    if interpretation
        .parameters
        .restore_fields
        .as_ref()
        .is_some_and(|fields| {
            fields
                .iter()
                .any(|field| !r.restorable_fields.contains(field))
        })
    {
        return Err(invalid());
    }
    if matches!(
        interpretation.intent,
        Intent::AcceptSuggestion | Intent::DeclineSuggestion
    ) {
        let p = &interpretation.parameters;
        if r.pending_suggestion.is_none()
            || interpretation.requires_confirmation
            || interpretation.uses_previous_draft
            || p.title.is_some()
            || p.title_suffix.is_some()
            || p.restore_fields.is_some()
            || p.priority.is_some()
            || p.project.is_some()
            || p.due_date.is_some()
            || p.due_time.is_some()
            || p.target.is_some()
            || p.panel.is_some()
            || p.status.is_some()
            || p.query_period.is_some()
        {
            return Err(invalid());
        }
    }
    // Enforce sensitive-action policy locally, regardless of model output.
    if interpretation.intent == Intent::DeleteTask {
        interpretation.requires_confirmation = true;
    }
    let missing = match interpretation.intent {
        Intent::CreateTask => interpretation.parameters.title.is_none(),
        Intent::UpdateTask | Intent::CompleteTask | Intent::DeleteTask => {
            interpretation.parameters.target.is_none()
        }
        Intent::OpenPanel => interpretation.parameters.panel.is_none(),
        _ => false,
    };
    if missing {
        interpretation.clarification = Some(
            match interpretation.intent {
                Intent::CreateTask => "Qual é o título da tarefa?",
                Intent::OpenPanel => "Qual painel você deseja abrir?",
                _ => "A qual tarefa existente você se refere?",
            }
            .into(),
        );
        if interpretation.intent != Intent::DeleteTask {
            interpretation.intent = Intent::Clarify;
        }
    }
    if interpretation.intent == Intent::Clarify && interpretation.clarification.is_none() {
        return Err(invalid());
    }
    Ok(interpretation)
}
fn http_error(status: u16, retry: Option<u64>) -> IntelligenceError {
    match status {
        401 | 403 => error("authentication", "Chave sem acesso ao modelo. Verifique a configuração local; não ative faturamento para esta PoC."),
        404 => error("model_unavailable", "gemini-3.5-flash-lite indisponível para este projeto."),
        429 => IntelligenceError { code: "rate_limit", message: "Quota da API atingida. Nenhuma ação executada; tente mais tarde.", retry_after_seconds: Some(retry.unwrap_or(60).clamp(6, 3600)) },
        500..=599 => error("unavailable", "Gemini temporariamente indisponível. Tente mais tarde."),
        _ => error("api_error", "A API recusou a solicitação. Nenhuma ação executada."),
    }
}
async fn generate(r: &Request, key: &str, count: u32) -> Result<Preview, IntelligenceError> {
    let start = Instant::now();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .connect_timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| error("network", "Não foi possível iniciar a conexão segura."))?;
    let response = client
        .post(ENDPOINT)
        .header("x-goog-api-key", key)
        .json(&request_body(r))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                error(
                    "timeout",
                    "Gemini excedeu 25 segundos. Nenhuma ação executada.",
                )
            } else {
                error("network", "Falha de conexão com Gemini. Verifique a rede.")
            }
        })?;
    if !response.status().is_success() {
        let retry = response
            .headers()
            .get("retry-after")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse().ok());
        return Err(http_error(response.status().as_u16(), retry));
    }
    // Cap response bytes; never forward provider error bodies or log personal content.
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| {
        if e.is_timeout() {
            error(
                "timeout",
                "Gemini excedeu 25 segundos. Nenhuma ação executada.",
            )
        } else {
            invalid()
        }
    })? {
        if bytes.len() + chunk.len() > 65536 {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    Ok(Preview {
        interpretation: parse_response(&value, r)?,
        dry_run: true,
        executed: false,
        model: MODEL,
        latency_ms: start.elapsed().as_millis(),
        request_count: count,
        prompt_tokens: value["usageMetadata"]["promptTokenCount"].as_u64(),
        output_tokens: value["usageMetadata"]["candidatesTokenCount"].as_u64(),
    })
}

pub async fn interpret(
    state: &IntelligenceState,
    request: Request,
) -> Result<Preview, IntelligenceError> {
    validate_request(&request)?;
    let key = std::env::var("GEMINI_API_KEY").ok().filter(|s| !s.trim().is_empty())
        .ok_or_else(|| error("not_configured", "Defina GEMINI_API_KEY no ambiente local do JARVIS. A chave nunca deve ir para o frontend."))?;
    let count = state
        .gate
        .lock()
        .map_err(|_| error("busy", "Interpretador indisponível."))?
        .reserve(Instant::now())?;
    let result = generate(&request, &key, count).await;
    if let Ok(mut gate) = state.gate.lock() {
        gate.busy = false;
        if let Err(e) = &result {
            if e.code == "rate_limit" {
                gate.next =
                    Some(Instant::now() + Duration::from_secs(e.retry_after_seconds.unwrap_or(60)));
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        Request {
            message: "Tenho que estudar amanhã".into(),
            context: vec![],
            previous_draft: None,
            previous_task: false,
            pending_suggestion: None,
            query_anchor: None,
            restorable_fields: vec![],
            local_now: Utc::now().to_rfc3339(),
            time_zone: "America/Sao_Paulo".into(),
        }
    }
    fn reply(intent: &str) -> Value {
        json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":json!({"intent":intent,"parameters":{"titleSuffix":null,"restoreFields":null,"queryPeriod":null,"status":null,"title":"Estudar","priority":null,"project":null,"dueDate":"2026-10-09","dueTime":null,"target":"estudar","panel":null},"reply":"Interpretei sua solicitação.","clarification":null,"requiresConfirmation":false,"usesPreviousDraft":false}).to_string()}]}}]})
    }
    #[test]
    fn contextual_edits_have_bounded_update_only_parameters() {
        let append = patch_reply(reply("update_task"), |i| {
            i["parameters"]["title"] = Value::Null;
            i["parameters"]["titleSuffix"] = json!("na C&T");
        });
        assert!(parse_response(&append, &request()).is_ok());
        let wrong_intent = patch_reply(append.clone(), |i| i["intent"] = json!("create_task"));
        assert!(parse_response(&wrong_intent, &request()).is_err());
        let conflicting = patch_reply(append.clone(), |i| {
            i["parameters"]["title"] = json!("Outro título")
        });
        assert!(parse_response(&conflicting, &request()).is_err());
        let oversized = patch_reply(append, |i| {
            i["parameters"]["titleSuffix"] = json!("a".repeat(201))
        });
        assert!(parse_response(&oversized, &request()).is_err());
    }
    #[test]
    fn restore_fields_require_known_names_in_current_local_context() {
        let value = patch_reply(reply("update_task"), |i| {
            i["parameters"]["restoreFields"] = json!(["project"]);
        });
        assert!(parse_response(&value, &request()).is_err());
        let mut r = request();
        r.restorable_fields = vec!["project".into()];
        assert!(parse_response(&value, &r).is_ok());
        for fields in [
            json!([]),
            json!(["completed"]),
            json!(["project", "project"]),
            json!(["priority"]),
        ] {
            let invalid = patch_reply(value.clone(), |i| i["parameters"]["restoreFields"] = fields);
            assert!(parse_response(&invalid, &r).is_err());
        }
        let wrong_intent = patch_reply(value, |i| i["intent"] = json!("delete_task"));
        assert!(parse_response(&wrong_intent, &r).is_err());
    }
    #[test]
    fn suggestion_decisions_require_context_and_no_action_parameters() {
        for intent in ["accept_suggestion", "decline_suggestion"] {
            let value = patch_reply(reply(intent), |i| {
                for field in i["parameters"].as_object_mut().unwrap().values_mut() {
                    *field = Value::Null;
                }
            });
            assert!(parse_response(&value, &request()).is_err());
            let mut r = request();
            r.pending_suggestion = Some("priority".into());
            assert!(parse_response(&value, &r).is_ok());
            let redirected = patch_reply(value.clone(), |i| {
                i["parameters"]["target"] = json!("outra tarefa")
            });
            assert!(parse_response(&redirected, &r).is_err());
            let confirmation = patch_reply(value, |i| i["requiresConfirmation"] = json!(true));
            assert!(parse_response(&confirmation, &r).is_err());
        }
    }
    #[test]
    fn week_of_date_requires_a_valid_anchor_and_query_intent() {
        let value = patch_reply(reply("query_tasks"), |i| {
            i["parameters"]["queryPeriod"] = json!("week_of_date");
            i["parameters"]["dueDate"] = json!("2026-10-23");
        });
        assert!(parse_response(&value, &request()).is_ok());
        for date in [Value::Null, json!("2026-02-30")] {
            let invalid_date = patch_reply(value.clone(), |i| i["parameters"]["dueDate"] = date);
            assert!(parse_response(&invalid_date, &request()).is_err());
        }
        let write = patch_reply(value, |i| i["intent"] = json!("create_task"));
        assert!(parse_response(&write, &request()).is_err());
    }
    #[test]
    fn minimal_conversational_context_is_validated() {
        let mut r = request();
        r.pending_suggestion = Some("delete".into());
        assert!(validate_request(&r).is_err());
        r.pending_suggestion = Some("panel".into());
        r.query_anchor = Some("2027-02-29".into());
        assert!(validate_request(&r).is_err());
        r.query_anchor = Some("2026-10-19".into());
        assert!(validate_request(&r).is_ok());
        let serialized = serde_json::to_value(&r).unwrap();
        assert_eq!(serialized["pendingSuggestion"], "panel");
        assert_eq!(serialized["queryAnchor"], "2026-10-19");
    }
    #[test]
    fn confirmation_is_local() {
        assert!(
            parse_response(&reply("delete_task"), &request())
                .unwrap()
                .requires_confirmation
        );
    }
    #[test]
    fn rejects_invalid_date_and_id() {
        let mut v = reply("create_task");
        let mut i: Value = serde_json::from_str(
            v["candidates"][0]["content"]["parts"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        i["parameters"]["dueDate"] = json!("2026-02-30");
        v["candidates"][0]["content"]["parts"][0]["text"] = json!(i.to_string());
        assert!(parse_response(&v, &request()).is_err());
        i["parameters"]["dueDate"] = Value::Null;
        i["parameters"]["id"] = json!(42);
        v["candidates"][0]["content"]["parts"][0]["text"] = json!(i.to_string());
        assert!(parse_response(&v, &request()).is_err());
    }
    fn patch_reply(mut value: Value, change: impl FnOnce(&mut Value)) -> Value {
        let slot = &mut value["candidates"][0]["content"]["parts"][0]["text"];
        let mut decoded: Value = serde_json::from_str(slot.as_str().unwrap()).unwrap();
        change(&mut decoded);
        *slot = json!(decoded.to_string());
        value
    }
    #[test]
    fn rejects_missing_fields_and_invented_enums() {
        for field in [
            "queryPeriod",
            "status",
            "title",
            "priority",
            "project",
            "dueDate",
            "dueTime",
            "target",
            "panel",
        ] {
            let v = patch_reply(reply("create_task"), |i| {
                i["parameters"].as_object_mut().unwrap().remove(field);
            });
            assert!(parse_response(&v, &request()).is_err());
        }
        for (field, value) in [
            ("queryPeriod", "this_month"),
            ("priority", "urgent"),
            ("dueTime", "25:00"),
            ("dueDate", "2027-02-29"),
            ("panel", "shell"),
        ] {
            let v = patch_reply(reply("create_task"), |i| {
                i["parameters"][field] = json!(value);
            });
            assert!(parse_response(&v, &request()).is_err());
        }
        let v = patch_reply(reply("create_task"), |i| {
            i["executed"] = json!(true);
        });
        assert!(parse_response(&v, &request()).is_err());
    }
    #[test]
    fn missing_targets_require_clarification_and_delete_still_requires_confirmation() {
        for intent in ["update_task", "complete_task", "delete_task"] {
            let v = patch_reply(reply(intent), |i| {
                i["parameters"]["target"] = Value::Null;
            });
            let parsed = parse_response(&v, &request()).unwrap();
            assert!(parsed.clarification.is_some());
            if intent == "delete_task" {
                assert!(parsed.requires_confirmation);
            } else {
                assert_eq!(parsed.intent, Intent::Clarify);
            }
        }
    }
    #[test]
    fn accepts_valid_leap_date_but_rejects_context_reference_without_a_draft() {
        let v = patch_reply(reply("create_task"), |i| {
            i["parameters"]["dueDate"] = json!("2028-02-29");
            i["parameters"]["dueTime"] = json!("19:00");
            i["usesPreviousDraft"] = json!(true);
        });
        let mut r = request();
        assert!(parse_response(&v, &r).is_err());
        r.previous_draft = Some(
            parse_response(&reply("create_task"), &r)
                .unwrap()
                .parameters,
        );
        assert_eq!(
            parse_response(&v, &r)
                .unwrap()
                .parameters
                .due_time
                .as_deref(),
            Some("19:00")
        );
    }
    #[test]
    fn limits_requests_without_retrying() {
        let mut gate = Gate::default();
        let now = Instant::now();
        assert_eq!(gate.reserve(now).unwrap(), 1);
        assert_eq!(gate.reserve(now).unwrap_err().code, "busy");
        gate.busy = false;
        assert_eq!(gate.reserve(now).unwrap_err().code, "rate_limit");
        gate.count = 20;
        assert_eq!(
            gate.reserve(now + Duration::from_secs(60))
                .unwrap_err()
                .code,
            "session_limit"
        );
    }
    #[test]
    fn validates_input_and_context() {
        let mut r = request();
        assert!(validate_request(&r).is_ok());
        r.context = vec!["x".into(); 7];
        assert!(validate_request(&r).is_err());
        r.context.clear();
        r.local_now = "2020-01-01T00:00:00-03:00".into();
        assert!(validate_request(&r).is_err());
    }
    #[test]
    fn rejects_truncated_blocked_and_invalid_context() {
        let mut v = reply("create_task");
        v["candidates"][0]["finishReason"] = json!("MAX_TOKENS");
        assert_eq!(
            parse_response(&v, &request()).unwrap_err().code,
            "blocked_response"
        );
        assert!(parse_response(&json!({}), &request()).is_err());
        assert!(parse_response(&reply("clarify"), &request()).is_err());
    }
    #[test]
    fn maps_errors_without_provider_content() {
        for (status, code) in [
            (403, "authentication"),
            (404, "model_unavailable"),
            (429, "rate_limit"),
            (503, "unavailable"),
            (400, "api_error"),
        ] {
            assert_eq!(http_error(status, None).code, code);
        }
        assert_eq!(http_error(429, Some(99999)).retry_after_seconds, Some(3600));
    }
    #[test]
    fn sends_only_interpretation_data_without_tools() {
        let body = request_body(&request());
        assert!(body.get("tools").is_none());
        assert!(body["generationConfig"]["responseJsonSchema"].is_object());
        assert!(!body.to_string().contains("GEMINI_API_KEY"));
    }
}
