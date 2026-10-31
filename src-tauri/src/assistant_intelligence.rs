//! Closed interpretation contract. No OS, database, weather HTTP or executor.
use crate::intelligence::{self, IntelligenceError, IntelligenceState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub task_context: intelligence::Request,
    pub city_context: Option<String>,
    pub active_capability: Option<String>,
    pub clarification: Option<String>,
    #[serde(default)]
    pub dialogue: Vec<DialogueMessage>,
}

/// Selected canonical session data, never privileged instructions.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueMessage {
    pub role: String,
    pub source: String,
    pub id: String,
    pub revision: u64,
    pub owner: String,
    pub created_at: i64,
    pub text: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Task,
    BrowserSearch,
    Weather,
    Research,
    Clarify,
    Conversation,
    Plan,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionIntent {
    ExecuteNow,
    Deferred,
    NonExecutive,
    Cancel,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Interpretation {
    pub execution_intent: ExecutionIntent,
    pub capability: Capability,
    pub task: Option<Value>,
    pub query: Option<String>,
    pub city: Option<String>,
    pub date: Option<String>,
    pub uses_city_context: bool,
    pub question: Option<String>,
    pub answer: Option<String>,
    pub plan_targets: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub interpretation: Interpretation,
    pub dry_run: bool,
    pub executed: bool,
    pub metrics: Option<Metrics>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub request_count: u32,
    pub latency_ms: u128,
    pub prompt_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

fn bounded(value: &Option<String>, limit: usize) -> bool {
    value.as_ref().is_none_or(|s| {
        !s.trim().is_empty() && s.chars().count() <= limit && !s.chars().any(char::is_control)
    })
}

fn explicit_reference(message: &str, reference: &str) -> bool {
    let message = message.to_lowercase();
    let reference = reference.trim().to_lowercase();
    message.match_indices(&reference).any(|(start, _)| {
        let before = message[..start].chars().next_back();
        let after = message[start + reference.len()..].chars().next();
        !before.is_some_and(|c| c.is_alphanumeric() || c == '#')
            && !after.is_some_and(char::is_alphanumeric)
    })
}

pub fn parse_response(raw: &Value, request: &Request) -> Result<Preview, IntelligenceError> {
    let bad = || intelligence::invalid();
    let candidates = raw["candidates"]
        .as_array()
        .filter(|c| c.len() == 1)
        .ok_or_else(|| intelligence::invalid_reason("candidate_shape"))?;
    let candidate = &candidates[0];
    if candidate["finishReason"] != "STOP" {
        return Err(intelligence::invalid_reason("finish_reason"));
    }
    let text: String = candidate["content"]["parts"]
        .as_array()
        .ok_or_else(bad)?
        .iter()
        .filter(|p| p["thought"] != true)
        .filter_map(|p| p["text"].as_str())
        .collect();
    if text.len() > 16000 {
        return Err(intelligence::invalid_reason("response_size"));
    }
    let value: Value = serde_json::from_str(&text).map_err(|_| intelligence::invalid_reason("json_syntax"))?;
    for field in [
        "executionIntent",
        "capability",
        "task",
        "query",
        "city",
        "date",
        "usesCityContext",
        "question",
    ] {
        if value.get(field).is_none() {
            return Err(intelligence::invalid_reason("required_fields"));
        }
    }
    let mut i: Interpretation = serde_json::from_value(value).map_err(|_| intelligence::invalid_reason("schema_fields"))?;
    // Disjoint payloads: free prose or plans can never hide tool arguments.
    if (!matches!(i.capability, Capability::Conversation) && i.answer.is_some())
        || (!matches!(i.capability, Capability::Plan) && i.plan_targets.is_some())
    {
        return Err(intelligence::invalid_reason("mixed_payload"));
    }
    if !bounded(&i.query, 1000) || !bounded(&i.city, 150) || !bounded(&i.question, 500) {
        return Err(intelligence::invalid_reason("field_bounds"));
    }
    if let Some(date) = &i.date {
        if date.len() != 10 || chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
            return Err(intelligence::invalid_reason("date_shape"));
        }
    }
    // Cancellation is a control turn, never a proposal with executable data.
    if i.execution_intent == ExecutionIntent::Cancel {
        if !matches!(i.capability, Capability::Clarify)
            || i.task.is_some()
            || i.query.is_some()
            || i.city.is_some()
            || i.date.is_some()
            || i.uses_city_context
            || i.question.is_some()
        {
            return Err(intelligence::invalid_reason("cancel_shape"));
        }
        return Ok(Preview {
            interpretation: i,
            dry_run: true,
            executed: false,
            metrics: None,
        });
    }
    match i.capability {
        Capability::Conversation | Capability::Plan => {
            if i.task.is_some() || i.query.is_some() || i.city.is_some() || i.date.is_some()
                || i.question.is_some() || i.uses_city_context {
                return Err(intelligence::invalid_reason("general_payload"));
            }
            if matches!(i.capability, Capability::Conversation) {
                if i.execution_intent != ExecutionIntent::NonExecutive
                    || !i.answer.as_ref().is_some_and(|s| !s.trim().is_empty()
                        && s.chars().count() <= 4000
                        && !s.chars().any(|c| c.is_control() && c != '\n' && c != '\t')) {
                    return Err(intelligence::invalid_reason("general_answer_shape"));
                }
            } else if !i.plan_targets.as_ref().is_some_and(|targets| !targets.is_empty()
                && targets.len() <= 20 && targets.iter().enumerate().all(|(n, s)|
                    !s.trim().is_empty() && s.chars().count() <= 200
                    && !s.chars().any(char::is_control) && !targets[..n].contains(s)
                    && explicit_reference(&request.task_context.message, s))) {
                return Err(intelligence::invalid_reason("plan_references"));
            }
        }
        Capability::Task => {
            if i.query.is_some()
                || i.city.is_some()
                || i.date.is_some()
                || i.question.is_some()
                || i.uses_city_context
            {
                return Err(intelligence::invalid_reason("task_payload"));
            }
            let task = i.task.as_ref().ok_or_else(|| intelligence::invalid_reason("content_parts"))?;
            // Reuse the stable task validator, including deletion confirmation.
            let envelope = json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":task.to_string()}]}}]});
            i.task = Some(
                serde_json::to_value(intelligence::parse_response(
                    &envelope,
                    &request.task_context,
                ).map_err(|e| if e.code == "invalid_response" && e.validation_reason.is_none() {
                    intelligence::invalid_reason("task_validation")
                } else { e })?)
                .map_err(|_| bad())?,
            );
        }
        Capability::BrowserSearch | Capability::Research => {
            if i.task.is_some()
                || i.city.is_some()
                || i.date.is_some()
                || i.question.is_some()
                || i.query.is_none()
            {
                return Err(intelligence::invalid_reason("search_payload"));
            }
            let query = i.query.as_deref().ok_or_else(bad)?;
            if i.uses_city_context {
                if request.city_context.is_none() || query.matches("{city}").count() != 1 {
                    return Err(intelligence::invalid_reason("city_reference"));
                }
            } else if query.contains("{city}") {
                return Err(intelligence::invalid_reason("city_placeholder"));
            }
        }
        Capability::Weather => {
            if i.task.is_some()
                || i.query.is_some()
                || i.question.is_some()
                || (i.city.is_some() == i.uses_city_context)
            {
                return Err(intelligence::invalid_reason("weather_payload"));
            }
            if i.uses_city_context && request.city_context.is_none() {
                return Err(intelligence::invalid_reason("weather_context"));
            }
        }
        Capability::Clarify => {
            if i.task.is_some()
                || i.query.is_some()
                || i.city.is_some()
                || i.date.is_some()
                || i.uses_city_context
            {
                return Err(intelligence::invalid_reason("clarification_payload"));
            }
            if !i.question.as_ref().is_some_and(|q| q.trim().ends_with('?')) {
                return Err(intelligence::invalid_reason("clarification_question"));
            }
        }
    }
    Ok(Preview {
        interpretation: i,
        dry_run: true,
        executed: false,
        metrics: None,
    })
}

pub async fn interpret(
    state: &IntelligenceState,
    request: Request,
) -> Result<Preview, IntelligenceError> {
    intelligence::validate_request(&request.task_context)?;
    if !bounded(&request.city_context, 250)
        || request.dialogue.len() > 6
        || request.dialogue.iter().any(|m| !["user", "assistant"].contains(&m.role.as_str())
            || !["user", "general_answer", "clarification", "weather_result"].contains(&m.source.as_str())
            || !["dashboard", "assistant"].contains(&m.owner.as_str())
            || m.id.len() > 128 || m.text.chars().count() > 1000)
        || request
            .clarification
            .as_ref()
            .is_some_and(|s| s.chars().count() > 1000)
        || request
            .active_capability
            .as_deref()
            .is_some_and(|c| !["weather", "browser_search", "task"].contains(&c))
    {
        return Err(intelligence::error(
            "invalid_input",
            "Contexto fora dos limites.",
        ));
    }
    let prompt = format!(
        "{}\n{}",
        include_str!("../../intelligence/habitual/prompt.txt"),
        include_str!("../../intelligence/prompt.txt")
    );
    let body = json!({
        "systemInstruction":{"parts":[{"text":prompt}]},
        "contents":[{"role":"user","parts":[{"text":serde_json::to_string(&request).map_err(|_| intelligence::invalid())?}]}],
        "generationConfig":{"temperature":0,"maxOutputTokens":2048,"responseMimeType":"application/json",
            "responseJsonSchema":serde_json::from_str::<Value>(include_str!("../../intelligence/habitual/schema.json")).map_err(|_| intelligence::invalid())?}
    });
    intelligence::interpret_body(state, body, |raw, count, latency| {
        let mut result = parse_response(&raw, &request)?;
        result.metrics = Some(Metrics { request_count: count, latency_ms: latency,
            prompt_tokens: raw["usageMetadata"]["promptTokenCount"].as_u64(),
            output_tokens: raw["usageMetadata"]["candidatesTokenCount"].as_u64() });
        Ok(result)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        serde_json::from_value(json!({"taskContext":{"message":"Pesquise notebooks ASUS","context":[],"previousDraft":null,"localNow":chrono::Utc::now().to_rfc3339(),"timeZone":"America/Sao_Paulo"},"cityContext":null,"activeCapability":null})).unwrap()
    }
    fn raw(value: Value) -> Value {
        json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":value.to_string()}]}}]})
    }
    fn search() -> Value {
        json!({"executionIntent":"execute_now","capability":"browser_search","task":null,"query":"notebooks ASUS","city":null,"date":null,"usesCityContext":false,"question":null})
    }
    #[test]
    fn invalid_clarification_exposes_only_a_fixed_diagnostic_category() {
        let mut value = search(); value["capability"] = json!("clarify");
        value["executionIntent"] = json!("non_executive"); value["query"] = Value::Null;
        value["question"] = json!("PRIVATE QUESTION WITHOUT PUNCTUATION");
        let error = parse_response(&raw(value), &request()).err().unwrap();
        assert_eq!(error.code, "invalid_response");
        assert_eq!(error.validation_reason, Some("clarification_question"));
        assert!(!serde_json::to_string(&error).unwrap().contains("PRIVATE"));
    }
    #[test]
    fn general_answers_are_non_executive_disjoint_and_bounded() {
        let mut value = search();
        value["capability"] = json!("conversation");
        value["executionIntent"] = json!("non_executive");
        value["query"] = Value::Null;
        value["answer"] = json!("A fotossíntese converte energia luminosa em energia química.");
        assert!(parse_response(&raw(value.clone()), &request()).is_ok());
        for (key, payload) in [("query", json!("segredos")), ("task", json!({})),
            ("executionIntent", json!("execute_now")), ("answer", json!("a".repeat(4001))),
            ("planTargets", json!(["#1"]))] {
            let mut bad = value.clone(); bad[key] = payload;
            assert!(parse_response(&raw(bad), &request()).is_err(), "{key}");
        }
        value["authorized"] = json!(true);
        assert!(parse_response(&raw(value), &request()).is_err());
    }
    #[test]
    fn plans_are_closed_references_never_authority_or_receipts() {
        let mut value = search();
        value["capability"] = json!("plan"); value["query"] = Value::Null;
        value["planTargets"] = json!(["#1", "Ensaio sintético"]);
        let mut request = request();
        request.task_context.message = "Prepare #1 e Ensaio sintético".into();
        let result = parse_response(&raw(value.clone()), &request).unwrap();
        assert!(!result.executed);
        for targets in [json!([]), json!(["#1", "#1"]), json!(vec!["x"; 21]), json!(["cmd\n.exe"])] {
            let mut bad = value.clone(); bad["planTargets"] = targets;
            assert!(parse_response(&raw(bad), &request).is_err());
        }
        for field in ["consent", "start", "owner", "grantId", "shell"] {
            let mut bad = value.clone(); bad[field] = json!("approved");
            assert!(parse_response(&raw(bad), &request).is_err());
        }
    }
    #[test]
    fn accepts_search_terms_without_executing() {
        let p = parse_response(&raw(search()), &request()).unwrap();
        assert!(p.dry_run);
        assert!(!p.executed);
    }
    #[test]
    fn rejects_commands_unknown_fields_and_mixed_capabilities() {
        for field in ["shell", "url", "executable"] {
            let mut value = search();
            value[field] = json!("cmd.exe");
            assert!(parse_response(&raw(value), &request()).is_err());
        }
        let mut value = search();
        value["city"] = json!("Belo Horizonte");
        assert!(parse_response(&raw(value), &request()).is_err());
        let mut value = search();
        value.as_object_mut().unwrap().remove("question");
        assert!(parse_response(&raw(value), &request()).is_err());
    }
    #[test]
    fn city_references_require_live_context_and_one_placeholder() {
        let mut value = search();
        value["usesCityContext"] = json!(true);
        value["query"] = json!("passeios em {city}");
        assert!(parse_response(&raw(value.clone()), &request()).is_err());
        let mut r = request();
        r.city_context = Some("Belo Horizonte, Minas Gerais, Brasil".into());
        assert!(parse_response(&raw(value.clone()), &r).is_ok());
        value["query"] = json!("passeios em Lisboa");
        assert!(parse_response(&raw(value), &r).is_err());
    }
    #[test]
    fn unsupported_research_is_not_search_opening() {
        let mut value = search();
        value["capability"] = json!("research");
        assert!(matches!(
            parse_response(&raw(value), &request())
                .unwrap()
                .interpretation
                .capability,
            Capability::Research
        ));
    }

    #[test]
    fn capability_without_intent_or_with_invented_intent_is_invalid() {
        let mut missing = search();
        missing.as_object_mut().unwrap().remove("executionIntent");
        assert!(parse_response(&raw(missing), &request()).is_err());
        for value in [
            Value::Null,
            json!(true),
            json!("approved"),
            json!("execute"),
        ] {
            let mut response = search();
            response["executionIntent"] = value;
            assert!(parse_response(&raw(response), &request()).is_err());
        }
    }

    #[test]
    fn deferred_and_non_executive_intents_are_explicit_and_never_execution_receipts() {
        for intent in ["deferred", "non_executive"] {
            let mut response = search();
            response["executionIntent"] = json!(intent);
            let preview = parse_response(&raw(response), &request()).unwrap();
            assert!(preview.dry_run);
            assert!(!preview.executed);
            assert_ne!(
                preview.interpretation.execution_intent,
                ExecutionIntent::ExecuteNow
            );
        }
    }

    #[test]
    fn semantic_cancel_cannot_carry_executable_arguments() {
        let response = json!({"executionIntent":"cancel","capability":"clarify","task":null,"query":null,"city":null,"date":null,"usesCityContext":false,"question":null});
        assert!(parse_response(&raw(response.clone()), &request()).is_ok());
        let mut invalid = response;
        invalid["query"] = json!("notebooks");
        assert!(parse_response(&raw(invalid), &request()).is_err());
    }
}
