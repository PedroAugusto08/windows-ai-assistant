//! Process-local canonical conversation. The frontend reducers own interpretation
//! rules; Rust owns ordering, snapshots, cancellation and effect admission.
use crate::{assistant_intelligence, authorization, browser_search, delegation, intelligence, tasks, weather};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{Emitter, State};

const STALE: &str = "A conversa mudou. Atualize e tente novamente.";
const BUSY: &str = "Já estou cuidando do pedido anterior.";
const OWNER: &str = "Revise e confirme na janela em que a proposta ou sugestão foi apresentada.";
const MAX_CONTEXT: usize = 512 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    pub kind: String,
    pub text: Option<String>,
    pub proposal_id: Option<String>,
    pub intelligence_enabled: Option<bool>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub id: String,
    pub destructive: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultData {
    pub text: String,
    pub panel: Option<String>,
    pub task_ids: Option<Vec<i64>>,
    pub executed: Option<bool>,
    pub approval: Option<Approval>,
    pub weather_attribution: Option<bool>,
    pub feedback: Option<String>,
    pub response_kind: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub text: String,
    pub response_kind: Option<String>,
    pub owner: String,
    pub revision: u64,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<Approval>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weather_attribution: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panel: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub generation: u64,
    pub messages: Vec<Message>,
    pub status: String,
    pub active_owner: Option<String>,
    pub approval_owner: Option<String>,
    pub context_owner: Option<String>,
    pub authority_owner: Option<String>,
    pub intelligence_enabled: bool,
    pub context: Value,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Begin {
    pub token: String,
    pub snapshot: Snapshot,
    pub context: Value,
    pub replayed: bool,
}
struct Active {
    token: String,
    owner: String,
    action: Action,
    inherited_authority: Option<String>,
    effects: HashSet<String>,
    effect_running: bool,
    client_id: Option<String>,
    orphaned: bool,
}
struct Receipt {
    owner: String,
    action: Action,
    token: String,
}
struct Session {
    revision: u64,
    generation: u64,
    sequence: u64,
    messages: Vec<Message>,
    context: Value,
    context_owner: Option<String>,
    authority_owner: Option<String>,
    approval_owner: Option<String>,
    approval_id: Option<String>,
    intelligence_enabled: bool,
    active: Option<Active>,
    receipts: HashMap<String, Receipt>,
    clients: HashMap<String, String>,
    executing: bool,
}
impl Default for Session {
    fn default() -> Self {
        Self {
            revision: 0,
            generation: 0,
            sequence: 0,
            messages: vec![],
            context: Value::Null,
            context_owner: None,
            authority_owner: None,
            approval_owner: None,
            approval_id: None,
            intelligence_enabled: true,
            active: None,
            receipts: HashMap::new(),
            clients: HashMap::new(),
            executing: false,
        }
    }
}
#[derive(Default)]
pub struct ConversationState {
    gate: Mutex<Session>,
}
impl Session {
    fn dialogue(&self, time: i64) -> Vec<assistant_intelligence::DialogueMessage> {
        let mut selected = Vec::new();
        // Only completed pairs, never the current input or an interrupted proposal.
        for pair in self.messages.windows(2).rev() {
            let (user, answer) = (&pair[0], &pair[1]);
            let source = match answer.response_kind.as_deref() {
                Some("general_answer") => "general_answer",
                Some("clarification") => "clarification",
                Some("tool_result") if answer.weather_attribution == Some(true) => "weather_result",
                _ => continue,
            };
            if user.role != "user" || answer.role != "assistant"
                || user.id.strip_suffix(":user") != answer.id.strip_suffix(":assistant")
                || time < user.created_at || time - user.created_at >= 15 * 60 * 1000 {
                continue;
            }
            for (m, source) in [(answer, source), (user, "user")] {
                selected.push(assistant_intelligence::DialogueMessage {
                    role: m.role.clone(), source: source.into(), id: m.id.clone(),
                    revision: m.revision, owner: m.owner.clone(), created_at: m.created_at,
                    text: m.text.chars().take(1000).collect(),
                });
            }
            if selected.len() == 6 { break; }
        }
        selected.reverse();
        selected
    }
    fn attach(&mut self, owner: &str, client_id: &str) -> Result<(Snapshot, bool), String> {
        if !matches!(owner, "dashboard" | "assistant")
            || client_id.is_empty()
            || client_id.len() > 128
            || !client_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_:.".contains(c))
        {
            return Err("Identidade da interface inválida.".into());
        }
        self.clients.insert(owner.into(), client_id.into());
        let replaced = self.active.as_ref().is_some_and(|active| {
            active.owner == owner && active.client_id.as_deref() != Some(client_id)
        });
        if replaced {
            if self.executing {
                // The effect already admitted must reach its terminal result.
                // Reload never pretends to cancel a committed or running write.
                self.active.as_mut().unwrap().orphaned = true;
                self.bump();
            } else {
                self.recover_orphan();
            }
        }
        Ok((self.snapshot(), replaced))
    }
    fn recover_orphan(&mut self) {
        let token = self
            .active
            .as_ref()
            .map(|active| active.token.clone())
            .unwrap_or_default();
        self.generation += 1;
        self.active = None;
        self.executing = false;
        self.context = Value::Null;
        self.context_owner = None;
        self.authority_owner = None;
        self.approval_owner = None;
        self.approval_id = None;
        for message in &mut self.messages {
            message.approval = None;
        }
        self.push(Message { id: format!("{token}:interrupted"), role: "assistant".into(),
            text: "A interface foi recarregada e o pedido foi interrompido. Não consegui confirmar seu resultado na conversa. Uma etapa já iniciada pode ter produzido efeito; confira as tarefas antes de repetir. Não repeti nenhuma operação.".into(),
            approval: None, weather_attribution: None, panel: None, response_kind: None, owner: String::new(), revision: self.revision, created_at: chrono::Utc::now().timestamp_millis() });
        self.bump();
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            revision: self.revision,
            generation: self.generation,
            messages: self.messages.clone(),
            status: if self.executing {
                "executing"
            } else if self.active.is_some() {
                "processing"
            } else if self.approval_owner.is_some() {
                "awaiting_approval"
            } else {
                "idle"
            }
            .into(),
            active_owner: self.active.as_ref().map(|a| a.owner.clone()),
            approval_owner: self.approval_owner.clone(),
            context_owner: self.context_owner.clone(),
            authority_owner: self.authority_owner.clone(),
            intelligence_enabled: self.intelligence_enabled,
            context: self.context.clone(),
        }
    }
    fn bump(&mut self) {
        self.revision += 1;
    }
    fn admit(&self, owner: &str, token: &str) -> Result<(), String> {
        if self
            .active
            .as_ref()
            .is_some_and(|a| a.owner == owner && a.token == token)
        {
            Ok(())
        } else {
            Err(STALE.into())
        }
    }
    fn push(&mut self, message: Message) {
        self.messages.push(message);
        if self.messages.len() > 60 {
            self.messages.remove(0);
        }
    }
    fn begin(
        &mut self,
        owner: &str,
        request_id: &str,
        revision: u64,
        action: Action,
    ) -> Result<Begin, String> {
        if !matches!(owner, "dashboard" | "assistant") {
            return Err("Janela inválida.".into());
        }
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_:.".contains(c))
        {
            return Err("Identificador de pedido inválido.".into());
        }
        if let Some(old) = self.receipts.get(request_id) {
            if old.owner != owner || old.action != action {
                return Err("Identificador já usado por outro pedido.".into());
            }
            return Ok(Begin {
                token: old.token.clone(),
                context: self.context.clone(),
                snapshot: self.snapshot(),
                replayed: true,
            });
        }
        if self.active.is_some() {
            return Err(BUSY.into());
        }
        if revision != self.revision {
            return Err(STALE.into());
        }
        if !matches!(action.kind.as_str(), "send" | "approve" | "cancel" | "demo") {
            return Err("Ação inválida.".into());
        }
        if action.kind == "send"
            && !action
                .text
                .as_ref()
                .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 1000)
        {
            return Err("Informe um pedido com até 1.000 caracteres.".into());
        }
        if matches!(action.kind.as_str(), "approve" | "cancel") {
            if self.approval_owner.as_deref() != Some(owner) {
                return Err(OWNER.into());
            }
            if action.proposal_id != self.approval_id {
                return Err(STALE.into());
            }
        }
        // Textual confirmation cannot transfer the authority of an inherited
        // task proposal or suggestion to another WebView.
        if action.kind == "send"
            && self.authority_owner.as_deref().is_some_and(|o| o != owner)
            && action
                .text
                .as_deref()
                .is_some_and(|s| s.trim().to_lowercase().starts_with("confirmo excluir"))
        {
            return Err(OWNER.into());
        }
        if self.receipts.len() >= 4096 {
            return Err("Limite local de pedidos atingido. Reinicie o aplicativo após concluir as operações.".into());
        }
        self.sequence += 1;
        let token = format!("{}:{}", self.generation, self.sequence);
        self.receipts.insert(
            request_id.into(),
            Receipt {
                owner: owner.into(),
                action: action.clone(),
                token: token.clone(),
            },
        );
        // Keep every accepted request ID until process exit, including after
        // clear. Refuse new requests at the bound rather than evict idempotency.
        for message in &mut self.messages {
            message.approval = None;
        }
        if let Some(text) = &action.text {
            self.push(Message {
                id: format!("{token}:user"),
                role: "user".into(),
                text: text.clone(),
                response_kind: None, owner: owner.into(), revision: self.revision, created_at: chrono::Utc::now().timestamp_millis(),
                approval: None,
                weather_attribution: None,
                panel: None,
            });
        }
        if action.kind == "demo" {
            self.intelligence_enabled = action
                .intelligence_enabled
                .unwrap_or(self.intelligence_enabled);
        }
        self.active = Some(Active {
            token: token.clone(),
            owner: owner.into(),
            action,
            inherited_authority: self.authority_owner.clone(),
            effects: HashSet::new(),
            effect_running: false,
            client_id: self.clients.get(owner).cloned(),
            orphaned: false,
        });
        self.bump();
        Ok(Begin {
            token,
            context: self.context.clone(),
            snapshot: self.snapshot(),
            replayed: false,
        })
    }
    fn reserve_effect(&mut self, owner: &str, token: &str, operation: &str) -> Result<(), String> {
        self.admit(owner, token)?;
        let active = self.active.as_mut().unwrap();
        if active.orphaned {
            return Err(STALE.into());
        }
        if active.effect_running {
            return Err(BUSY.into());
        }
        if operation == "approve_operation"
            && active.action.kind == "send"
            && active
                .inherited_authority
                .as_deref()
                .is_some_and(|o| o != owner)
        {
            return Err(OWNER.into());
        }
        let once_key = match operation {
            "interpret_assistant" | "interpret_command" => Some("interpretation"),
            "prepare_operation" | "approve_operation" | "open_browser_search" | "get_weather" | "executor_prepare" => {
                Some(operation)
            }
            "list_tasks" | "cancel_operation" => None,
            _ => return Err("Ferramenta indisponível.".into()),
        };
        if let Some(key) = once_key {
            if !active.effects.insert(key.into()) {
                return Err(
                    "Essa etapa já foi tentada. Confira o resultado antes de repetir.".into(),
                );
            }
        }
        active.effect_running = true;
        self.executing = !matches!(operation, "interpret_assistant" | "interpret_command");
        self.bump();
        Ok(())
    }
    fn effect_done(&mut self, owner: &str, token: &str) -> Result<(), String> {
        self.admit(owner, token)?;
        if self.active.as_ref().unwrap().orphaned {
            self.recover_orphan();
            return Err(STALE.into());
        }
        self.active.as_mut().unwrap().effect_running = false;
        self.executing = false;
        self.bump();
        Ok(())
    }
    fn finish(
        &mut self,
        owner: &str,
        token: &str,
        context: Value,
        result: Option<ResultData>,
    ) -> Result<Snapshot, String> {
        self.admit(owner, token)?;
        if self.active.as_ref().unwrap().effect_running {
            return Err(BUSY.into());
        }
        if !context.is_null()
            && (context.get("version") != Some(&json!(1))
                || serde_json::to_vec(&context)
                    .map_err(|_| "Contexto inválido.")?
                    .len()
                    > MAX_CONTEXT)
        {
            return Err("Contexto inválido ou excessivo.".into());
        }
        if result.as_ref().is_some_and(|r| {
            r.response_kind.as_deref().is_some_and(|k| !["general_answer", "clarification", "proposal", "tool_result", "unavailable"].contains(&k))
                || r.text.chars().count() > 20000
                || r.panel
                    .as_deref()
                    .is_some_and(|p| !matches!(p, "tasks" | "chat" | "agenda" | "system"))
        }) {
            return Err("Resposta inválida.".into());
        }
        if let Some(approval) = result.as_ref().and_then(|r| r.approval.as_ref()) {
            if self.approval_owner.as_deref() != Some(owner)
                || self.approval_id.as_deref() != Some(approval.id.as_str())
            {
                return Err("A proposta não foi confirmada pelo aplicativo.".into());
            }
        }
        let old_authority = authority(&self.context);
        let new_authority = authority(&context);
        self.authority_owner = if new_authority.is_null() {
            None
        } else if old_authority == new_authority
            || ["staged", "suggestion"].iter().any(|key| {
                !new_authority[key].is_null() && new_authority[key] == old_authority[key]
            })
        {
            self.authority_owner.clone().or_else(|| Some(owner.into()))
        } else {
            Some(owner.into())
        };
        self.context = context;
        self.context_owner = Some(owner.into());
        if let Some(result) = result {
            if result.approval.is_none() {
                self.approval_owner = None;
                self.approval_id = None;
            }
            self.push(Message {
                id: format!("{token}:assistant"),
                role: "assistant".into(),
                text: result.text,
                response_kind: result.response_kind, owner: owner.into(), revision: self.revision, created_at: chrono::Utc::now().timestamp_millis(),
                approval: result.approval,
                weather_attribution: result.weather_attribution,
                panel: result.panel,
            });
        }
        self.active = None;
        self.bump();
        Ok(self.snapshot())
    }
    fn clear(&mut self, revision: u64) -> Result<Snapshot, String> {
        if self.executing {
            return Err("Aguarde a etapa em execução antes de limpar a conversa.".into());
        }
        if revision != self.revision {
            return Err(STALE.into());
        }
        self.generation += 1;
        self.messages.clear();
        self.context = Value::Null;
        self.context_owner = None;
        self.authority_owner = None;
        self.approval_owner = None;
        self.approval_id = None;
        self.active = None;
        self.bump();
        Ok(self.snapshot())
    }
}
fn authority(context: &Value) -> Value {
    let staged = context
        .pointer("/tasks/staged")
        .cloned()
        .unwrap_or(Value::Null);
    let suggestion = context
        .pointer("/tasks/suggestion")
        .cloned()
        .unwrap_or(Value::Null);
    if staged.is_null() && suggestion.is_null() {
        Value::Null
    } else {
        json!({"staged":staged,"suggestion":suggestion})
    }
}
fn emit(app: &tauri::AppHandle, snapshot: &Snapshot) {
    let _ = app.emit("conversation-changed", snapshot);
}
fn err(message: impl Into<String>) -> Value {
    Value::String(message.into())
}
fn decode<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, Value> {
    serde_json::from_value(args).map_err(|_| err("Argumentos inválidos."))
}
fn encode<T: Serialize>(value: T) -> Result<Value, Value> {
    serde_json::to_value(value)
        .map_err(|_| err("Retorno indisponível; não repita automaticamente."))
}

#[tauri::command]
pub fn conversation_attach(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, Arc<ConversationState>>,
    authorization: State<'_, Arc<authorization::AuthorizationState>>,
    client_id: String,
) -> Result<Snapshot, String> {
    let mut session = state.gate.lock().map_err(|_| "Conversa indisponível.")?;
    let (snapshot, interrupted) = session.attach(window.label(), &client_id)?;
    if interrupted {
        authorization.cancel_conversation_proposals()?;
    }
    emit(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn conversation_metrics(state: State<'_, intelligence::IntelligenceState>) -> Result<intelligence::Usage, intelligence::IntelligenceError> {
    state.usage()
}
#[tauri::command]
pub fn conversation_snapshot(state: State<'_, Arc<ConversationState>>) -> Result<Snapshot, String> {
    Ok(state
        .gate
        .lock()
        .map_err(|_| "Conversa indisponível.")?
        .snapshot())
}
#[tauri::command]
pub fn conversation_begin(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, Arc<ConversationState>>,
    authorization: State<'_, Arc<authorization::AuthorizationState>>,
    request_id: String,
    expected_revision: u64,
    action: Action,
) -> Result<Begin, String> {
    let mut session = state.gate.lock().map_err(|_| "Conversa indisponível.")?;
    let begin = session.begin(window.label(), &request_id, expected_revision, action)?;
    // Only direct button or exact textual control turns retain an existing
    // proposal. All fresh requests revoke both owners before any network wait.
    let control = session.active.as_ref().is_some_and(|a| {
        matches!(a.action.kind.as_str(), "approve" | "cancel")
            || a.action.text.as_deref().is_some_and(|s| {
                s.trim().to_lowercase().starts_with("confirmo excluir")
                    || matches!(
                        s.trim().to_lowercase().as_str(),
                        "cancelar" | "cancela" | "não" | "nao"
                    )
            })
    });
    if !begin.replayed && !control {
        authorization.cancel_conversation_proposals()?;
        session.approval_owner = None;
        session.approval_id = None;
    }
    let result = Begin {
        snapshot: session.snapshot(),
        ..begin
    };
    emit(&app, &result.snapshot);
    Ok(result)
}
#[tauri::command]
pub fn conversation_finish(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, Arc<ConversationState>>,
    authorization: State<'_, Arc<authorization::AuthorizationState>>,
    token: String,
    context: Value,
    result: Option<ResultData>,
) -> Result<Snapshot, String> {
    let mut session = state.gate.lock().map_err(|_| "Conversa indisponível.")?;
    let snapshot = session.finish(window.label(), &token, context, result)?;
    if session.approval_owner.is_none() {
        authorization.cancel_conversation_proposals()?;
    }
    emit(&app, &snapshot);
    Ok(snapshot)
}
#[tauri::command]
pub fn conversation_clear(
    app: tauri::AppHandle,
    state: State<'_, Arc<ConversationState>>,
    authorization: State<'_, Arc<authorization::AuthorizationState>>,
    expected_revision: u64,
) -> Result<Snapshot, String> {
    let mut session = state.gate.lock().map_err(|_| "Conversa indisponível.")?;
    if session.executing {
        return Err("Aguarde a etapa em execução antes de limpar a conversa.".into());
    }
    if session.revision != expected_revision {
        return Err(STALE.into());
    }
    authorization.cancel_conversation_proposals()?;
    let snapshot = session.clear(expected_revision)?;
    emit(&app, &snapshot);
    Ok(snapshot)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestArg<T> {
    request: T,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EffectArg {
    effect: authorization::Effect,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposalArg {
    proposal_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryArg {
    query: String,
}

#[tauri::command]
pub async fn conversation_effect(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, Arc<ConversationState>>,
    store: State<'_, Arc<tasks::TaskStore>>,
    authorization: State<'_, Arc<authorization::AuthorizationState>>,
    intelligence_state: State<'_, intelligence::IntelligenceState>,
    runtime: State<'_, Arc<delegation::DelegationRuntime>>,
    token: String,
    operation: String,
    args: Value,
) -> Result<Value, Value> {
    let owner = window.label().to_string();
    {
        let mut session = state
            .gate
            .lock()
            .map_err(|_| err("Conversa indisponível."))?;
        session
            .reserve_effect(&owner, &token, &operation)
            .map_err(err)?;
        emit(&app, &session.snapshot());
    }
    // No conversation mutex crosses these network awaits. Clear can revoke
    // their token; the continuation is checked again before returning.
    let result = match operation.as_str() {
        "interpret_assistant" => {
            match decode::<RequestArg<assistant_intelligence::Request>>(args) {
                Ok(mut a) => {
                    // Never trust a frontend-supplied history, role, revision or current message.
                    {
                        let session = state.gate.lock().map_err(|_| err("Conversa indisponível."))?;
                        session.admit(&owner, &token).map_err(err)?;
                        let active = session.active.as_ref().ok_or_else(|| err(STALE))?;
                        a.request.task_context.message = active.action.text.clone().ok_or_else(|| err(STALE))?;
                        a.request.dialogue = session.dialogue(chrono::Utc::now().timestamp_millis());
                        // Share the existing 6000-character context budget rather
                        // than adding a second unbounded history allowance.
                        let legacy: usize = a.request.task_context.context.iter().map(|s| s.chars().count()).sum();
                        while legacy + a.request.dialogue.iter().map(|m| m.text.chars().count()).sum::<usize>() > 6000 {
                            if a.request.dialogue.len() < 2 { a.request.dialogue.clear(); break; }
                            a.request.dialogue.drain(..2);
                        }
                    }
                    match assistant_intelligence::interpret(&intelligence_state, a.request).await {
                        Ok(r) => encode(r),
                        Err(e) => Err(serde_json::to_value(e)
                            .unwrap_or_else(|_| err("Interpretação indisponível."))),
                    }
                }
                Err(e) => Err(e),
            }
        }
        "interpret_command" => {
            match decode::<RequestArg<intelligence::Request>>(args) {
                Ok(a) => match intelligence::interpret(&intelligence_state, a.request).await {
                    Ok(r) => encode(r),
                    Err(e) => Err(serde_json::to_value(e)
                        .unwrap_or_else(|_| err("Interpretação indisponível."))),
                },
                Err(e) => Err(e),
            }
        }
        "get_weather" => match decode::<RequestArg<weather::Request>>(args) {
            Ok(a) => weather::get_weather(a.request)
                .await
                .map_err(err)
                .and_then(encode),
            Err(e) => Err(e),
        },
        _ => {
            let state = state.inner().clone();
            let store = store.inner().clone();
            let authorization = authorization.inner().clone();
            let runtime = runtime.inner().clone();
            let owner = owner.clone();
            let token = token.clone();
            let operation = operation.clone();
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                // Admission and the actual synchronous effect form one critical
                // section. Clear cannot race between checking and writing/opening.
                let mut session = state
                    .gate
                    .lock()
                    .map_err(|_| err("Conversa indisponível."))?;
                session.admit(&owner, &token).map_err(err)?;
                match operation.as_str() {
                    "list_tasks" => store.list().map_err(err).and_then(encode),
                    "executor_prepare" => {
                        #[derive(Deserialize)]
                        #[serde(rename_all = "camelCase", deny_unknown_fields)]
                        struct PlanArg { request: delegation::executor::Proposal, expected_revision: i64 }
                        let a: PlanArg = decode(args)?;
                        let goal = runtime.executor_prepare_conversation(&store, &owner, a.request, a.expected_revision).map_err(err)?;
                        let _ = app.emit("executor-changed", ());
                        encode(goal)
                    }
                    "prepare_operation" => {
                        let a: EffectArg = decode(args)?;
                        let proposal = authorization
                            .prepare_for_conversation(&owner, &store, a.effect, Instant::now())
                            .map_err(err)?;
                        session.approval_owner = Some(owner.clone());
                        session.approval_id = Some(proposal.proposal_id.clone());
                        encode(proposal)
                    }
                    "approve_operation" => {
                        let a: ProposalArg = decode(args)?;
                        let snapshot = authorization
                            .approve_for_conversation(
                                &owner,
                                &a.proposal_id,
                                &store,
                                Instant::now(),
                            )
                            .map_err(err)?;
                        session.approval_owner = None;
                        session.approval_id = None;
                        // A failed UI event never changes the at-most-once result.
                        let _ = app.emit("tasks-changed", &snapshot);
                        encode(snapshot)
                    }
                    "cancel_operation" => {
                        let a: ProposalArg = decode(args)?;
                        // Cancelling the inherited proposal is safe from either
                        // window, but cannot consume or redirect an approval.
                        if session.approval_id.as_deref() == Some(&a.proposal_id)
                            && session.approval_owner.as_deref() != Some(&owner)
                        {
                            return Err(err(OWNER));
                        }
                        authorization
                            .cancel_for_conversation(&owner, Some(&a.proposal_id))
                            .map_err(err)?;
                        if session.approval_owner.as_deref() == Some(&owner)
                            && session.approval_id.as_deref() == Some(&a.proposal_id)
                        {
                            session.approval_owner = None;
                            session.approval_id = None;
                        }
                        Ok(Value::Null)
                    }
                    "open_browser_search" => {
                        let a: QueryArg = decode(args)?;
                        browser_search::open_google_search(&a.query).map_err(err)?;
                        Ok(Value::Null)
                    }
                    _ => Err(err("Ferramenta indisponível.")),
                }
            })
            .await
            .unwrap_or_else(|_| {
                Err(err(
                    "Etapa interrompida; confira o resultado antes de repetir.",
                ))
            })
        }
    };
    let mut session = state
        .gate
        .lock()
        .map_err(|_| err("Conversa indisponível."))?;
    let recovering_orphan = session
        .active
        .as_ref()
        .is_some_and(|active| active.owner == owner && active.token == token && active.orphaned);
    let completed = session.effect_done(&owner, &token);
    if recovering_orphan {
        // Orphan recovery is performed only after the admitted effect returned.
        // Revoke pending drafts while preserving the result's uncertainty.
        authorization.cancel_conversation_proposals().map_err(err)?;
    }
    emit(&app, &session.snapshot());
    completed.map_err(err)?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn action(text: &str) -> Action {
        Action {
            kind: "send".into(),
            text: Some(text.into()),
            proposal_id: None,
            intelligence_enabled: None,
        }
    }
    fn result(text: &str) -> ResultData {
        ResultData {
            text: text.into(),
            panel: None,
            task_ids: None,
            executed: None,
            approval: None,
            weather_attribution: None,
            feedback: None,
            response_kind: None,
        }
    }
    #[test]
    fn canonical_dialogue_has_provenance_expiry_and_excludes_operational_history() {
        let mut s = Session::default();
        for n in 0..5 {
            let owner = if n % 2 == 0 { "dashboard" } else { "assistant" };
            let b = s.begin(owner, &format!("req{n}"), s.revision, action("Dado sintético")).unwrap();
            let mut reply = result("Explicação sintética"); reply.response_kind = Some("general_answer".into());
            s.finish(owner, &b.token, Value::Null, Some(reply)).unwrap();
        }
        let now = chrono::Utc::now().timestamp_millis();
        let messages = s.dialogue(now);
        assert_eq!(messages.len(), 6);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].source, "general_answer");
        assert_eq!(messages[0].owner, "dashboard");
        assert!(messages[5].revision >= messages[0].revision);
        assert!(s.dialogue(now + 15 * 60 * 1000).is_empty());
        let b = s.begin("assistant", "tool", s.revision, action("Crie tarefa privada")).unwrap();
        let mut reply = result("Título privado confirmado"); reply.response_kind = Some("tool_result".into());
        s.finish("assistant", &b.token, Value::Null, Some(reply)).unwrap();
        assert!(!s.dialogue(now).iter().any(|m| m.text.contains("privad")));
        s.clear(s.revision).unwrap();
        assert!(s.dialogue(now).is_empty());
    }
    #[test]
    fn conversation_can_prepare_but_never_consent_start_or_replay_a_plan() {
        let mut s = Session::default();
        let b = s.begin("dashboard", "plan", 0, action("Prepare #1")).unwrap();
        assert!(s.reserve_effect("assistant", &b.token, "executor_prepare").is_err());
        for operation in ["executor_consent", "executor_start", "execute_delegated_task"] {
            assert!(s.reserve_effect("dashboard", &b.token, operation).is_err());
        }
        s.reserve_effect("dashboard", &b.token, "executor_prepare").unwrap();
        s.effect_done("dashboard", &b.token).unwrap();
        assert!(s.reserve_effect("dashboard", &b.token, "executor_prepare").is_err());
    }
    #[test]
    fn concurrent_windows_admit_only_one_turn() {
        let state = ConversationState::default();
        let outcomes = std::thread::scope(|scope| {
            let a = scope.spawn(|| {
                state
                    .gate
                    .lock()
                    .unwrap()
                    .begin("dashboard", "a", 0, action("primeiro"))
            });
            let b = scope.spawn(|| {
                state
                    .gate
                    .lock()
                    .unwrap()
                    .begin("assistant", "b", 0, action("segundo"))
            });
            [a.join().unwrap(), b.join().unwrap()]
        });
        assert_eq!(outcomes.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(state.gate.lock().unwrap().messages.len(), 1);
    }
    #[test]
    fn replay_matches_payload_and_cannot_repeat_effects() {
        let mut s = Session::default();
        let begin = s.begin("dashboard", "a", 0, action("pedido")).unwrap();
        assert!(
            s.begin("dashboard", "a", 0, action("pedido"))
                .unwrap()
                .replayed
        );
        assert!(s.begin("dashboard", "a", 0, action("diferente")).is_err());
        assert!(s.begin("assistant", "a", 0, action("pedido")).is_err());
        s.reserve_effect("dashboard", &begin.token, "open_browser_search")
            .unwrap();
        s.effect_done("dashboard", &begin.token).unwrap();
        assert!(s
            .reserve_effect("dashboard", &begin.token, "open_browser_search")
            .is_err());
        s.finish(
            "dashboard",
            &begin.token,
            Value::Null,
            Some(result("concluído")),
        )
        .unwrap();
        assert!(
            s.begin("dashboard", "a", 0, action("pedido"))
                .unwrap()
                .replayed
        );
        assert_eq!(s.messages.len(), 2);
        assert!(s
            .finish(
                "dashboard",
                &begin.token,
                Value::Null,
                Some(result("duplicado"))
            )
            .is_err());
    }
    #[test]
    fn clear_revokes_network_results_and_future_effects_but_not_running_execution() {
        let mut s = Session::default();
        let b = s.begin("dashboard", "a", 0, action("pedido")).unwrap();
        s.reserve_effect("dashboard", &b.token, "interpret_assistant")
            .unwrap();
        assert_eq!(s.snapshot().status, "processing");
        s.clear(s.revision).unwrap();
        assert!(s.effect_done("dashboard", &b.token).is_err());
        assert!(s
            .reserve_effect("dashboard", &b.token, "prepare_operation")
            .is_err());
        assert!(s
            .finish("dashboard", &b.token, Value::Null, Some(result("atrasado")))
            .is_err());
        let b = s
            .begin("assistant", "b", s.revision, action("novo"))
            .unwrap();
        s.reserve_effect("assistant", &b.token, "approve_operation")
            .unwrap();
        assert_eq!(s.snapshot().status, "executing");
        assert!(s.clear(s.revision).is_err());
        s.effect_done("assistant", &b.token).unwrap();
        s.clear(s.revision).unwrap();
        assert!(s.messages.is_empty());
    }
    #[test]
    fn origin_authority_survives_foreign_questions_and_blocks_text_approval() {
        let mut s = Session::default();
        s.context = json!({"version":1,"tasks":{"staged":null,"suggestion":{"kind":"priority"}}});
        s.authority_owner = Some("dashboard".into());
        let b = s
            .begin("assistant", "a", 0, action("qual sugestão?"))
            .unwrap();
        assert!(s
            .reserve_effect("assistant", &b.token, "approve_operation")
            .is_err());
        s.finish(
            "assistant",
            &b.token,
            s.context.clone(),
            Some(result("a sugestão")),
        )
        .unwrap();
        assert_eq!(s.authority_owner.as_deref(), Some("dashboard"));
        assert!(s
            .begin("assistant", "b", s.revision, action("confirmo excluir 1"))
            .is_err());
    }
    #[test]
    fn history_is_bounded_and_context_shared_across_owners() {
        let mut s = Session::default();
        for i in 0..40 {
            let owner = if i % 2 == 0 { "dashboard" } else { "assistant" };
            let b = s
                .begin(owner, &format!("r{i}"), s.revision, action("pedido"))
                .unwrap();
            if i > 0 {
                assert_eq!(b.context["city"], "Cidade sintética");
            }
            s.finish(
                owner,
                &b.token,
                json!({"version":1,"city":"Cidade sintética"}),
                Some(result("resposta")),
            )
            .unwrap();
        }
        assert_eq!(s.messages.len(), 60);
        assert_eq!(s.messages[0].id, "0:11:user");
        assert!(s.begin("dashboard", "stale", 0, action("velho")).is_err());
    }
    #[test]
    fn rejects_foreign_button_approval_and_unknown_operations() {
        let mut s = Session::default();
        s.approval_owner = Some("dashboard".into());
        s.approval_id = Some("1".into());
        let action = Action {
            kind: "approve".into(),
            text: None,
            proposal_id: Some("1".into()),
            intelligence_enabled: None,
        };
        assert!(s.begin("assistant", "a", 0, action.clone()).is_err());
        let b = s.begin("dashboard", "a", 0, action).unwrap();
        assert!(s
            .reserve_effect("assistant", &b.token, "approve_operation")
            .is_err());
        assert!(s.reserve_effect("dashboard", &b.token, "shell").is_err());
        s.reserve_effect("dashboard", &b.token, "approve_operation")
            .unwrap();
        s.effect_done("dashboard", &b.token).unwrap();
        assert!(s
            .reserve_effect("dashboard", &b.token, "approve_operation")
            .is_err());
    }
    #[test]
    fn invalid_finish_is_atomic_and_retains_original_context() {
        let mut s = Session::default();
        s.context = json!({"version":1,"city":"anterior"});
        let b = s.begin("dashboard", "a", 0, action("pedido")).unwrap();
        let revision = s.revision;
        let mut forged = result("proposta fictícia");
        forged.approval = Some(Approval {
            id: "999".into(),
            destructive: false,
        });
        assert!(s
            .finish(
                "dashboard",
                &b.token,
                json!({"version":1,"city":"indevida"}),
                Some(forged)
            )
            .is_err());
        assert_eq!(s.context["city"], "anterior");
        assert_eq!(s.revision, revision);
        assert!(s.active.is_some());
        assert!(s
            .finish(
                "dashboard",
                &b.token,
                json!({"version":2}),
                Some(result("inválido"))
            )
            .is_err());
        assert_eq!(s.context["city"], "anterior");
    }
    #[test]
    fn demo_preserves_mode_and_receipts_survive_clear() {
        let mut s = Session::default();
        s.intelligence_enabled = false;
        let a = Action {
            kind: "demo".into(),
            text: Some("demonstração".into()),
            proposal_id: None,
            intelligence_enabled: None,
        };
        let b = s.begin("dashboard", "a", 0, a.clone()).unwrap();
        assert!(!s.intelligence_enabled);
        s.finish(
            "dashboard",
            &b.token,
            Value::Null,
            Some(result("demonstração")),
        )
        .unwrap();
        s.clear(s.revision).unwrap();
        assert!(s.begin("dashboard", "a", s.revision, a).unwrap().replayed);
        assert!(s.messages.is_empty());
    }
    #[test]
    fn foreign_effect_and_overlapping_interpretation_are_rejected() {
        let mut s = Session::default();
        let b = s.begin("dashboard", "a", 0, action("pedido")).unwrap();
        assert!(s
            .reserve_effect("assistant", &b.token, "prepare_operation")
            .is_err());
        s.reserve_effect("dashboard", &b.token, "interpret_assistant")
            .unwrap();
        assert!(s
            .reserve_effect("dashboard", &b.token, "list_tasks")
            .is_err());
        s.effect_done("dashboard", &b.token).unwrap();
        assert!(s
            .reserve_effect("dashboard", &b.token, "interpret_command")
            .is_err());
    }

    #[test]
    fn reload_revokes_processing_but_repeat_attach_and_other_window_do_not() {
        let mut s = Session::default();
        s.attach("dashboard", "first").unwrap();
        let b = s
            .begin("dashboard", "a", s.revision, action("pedido"))
            .unwrap();
        s.reserve_effect("dashboard", &b.token, "interpret_assistant")
            .unwrap();
        assert!(!s.attach("dashboard", "first").unwrap().1);
        assert!(!s.attach("assistant", "floating").unwrap().1);
        assert!(s.active.is_some());
        let (snapshot, interrupted) = s.attach("dashboard", "reload").unwrap();
        assert!(interrupted);
        assert_eq!(snapshot.status, "idle");
        assert_eq!(snapshot.generation, 1);
        assert!(s.effect_done("dashboard", &b.token).is_err());
        assert!(s
            .finish("dashboard", &b.token, Value::Null, Some(result("atrasada")))
            .is_err());
        assert!(s
            .reserve_effect("dashboard", &b.token, "prepare_operation")
            .is_err());
        assert_eq!(s.messages.len(), 2);
        assert!(s.messages.last().unwrap().text.contains("Não repeti"));
        assert!(
            s.begin("dashboard", "a", s.revision, action("pedido"))
                .unwrap()
                .replayed
        );
    }
    #[test]
    fn reload_waits_for_running_effect_and_then_recovers_without_replay() {
        let mut s = Session::default();
        s.attach("dashboard", "first").unwrap();
        let b = s
            .begin("dashboard", "a", s.revision, action("pedido"))
            .unwrap();
        s.reserve_effect("dashboard", &b.token, "approve_operation")
            .unwrap();
        let (snapshot, interrupted) = s.attach("dashboard", "reload").unwrap();
        assert!(interrupted);
        assert_eq!(snapshot.status, "executing");
        assert!(s.active.is_some());
        assert!(s.clear(s.revision).is_err());
        assert!(s
            .begin("assistant", "b", s.revision, action("concorrente"))
            .is_err());
        assert!(s.effect_done("dashboard", &b.token).is_err());
        assert!(s.active.is_none());
        assert_eq!(s.snapshot().status, "idle");
        assert!(s.context.is_null());
        assert!(s.authority_owner.is_none());
        assert!(s
            .messages
            .last()
            .unwrap()
            .text
            .contains("pode ter produzido efeito"));
        assert!(s
            .finish("dashboard", &b.token, Value::Null, Some(result("atrasada")))
            .is_err());
        assert!(s
            .reserve_effect("dashboard", &b.token, "approve_operation")
            .is_err());
    }
}
