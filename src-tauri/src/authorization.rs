//! Conversation proposals carry no authority. Approval consumes a stored effect,
//! scoped to the originating window, before attempting the checked database write.
use crate::tasks::{Snapshot, Task, TaskInput, TaskStore};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, State};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub title: String,
    pub description: String,
    pub priority: String,
    pub project: String,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
}
impl Input {
    fn task_input(&self) -> TaskInput {
        TaskInput {
            title: self.title.clone(),
            description: self.description.clone(),
            priority: self.priority.clone(),
            project: self.project.clone(),
            due_date: self.due_date.clone(),
            due_time: self.due_time.clone(),
        }
    }
    fn canonicalize(&mut self) -> Result<(), String> {
        self.title = self.title.trim().into();
        self.description = self.description.trim().into();
        self.project = self.project.trim().into();
        if self.title.is_empty()
            || self.title.chars().count() > 200
            || self.description.chars().count() > 5000
            || self.project.chars().count() > 100
            || !["low", "normal", "high"].contains(&self.priority.as_str())
        {
            return Err("Campos inválidos.".into());
        }
        if let Some(date) = &self.due_date {
            if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
                return Err("Data inválida.".into());
            }
        }
        if let Some(time) = &self.due_time {
            if self.due_date.is_none() || chrono::NaiveTime::parse_from_str(time, "%H:%M").is_err()
            {
                return Err("Horário inválido.".into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    CreateTask,
    UpdateTask,
    CompleteTask,
    DeleteTask,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Effect {
    pub kind: Kind,
    pub id: Option<i64>,
    pub input: Option<Input>,
    pub expected_revision: i64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub proposal_id: String,
    pub effect: Effect,
    pub before: Option<Task>,
    pub expires_in_seconds: u64,
}
struct Pending {
    proposal: Proposal,
    expires: Instant,
}
#[derive(Default)]
struct Gate {
    sequence: u64,
    pending: HashMap<String, Pending>,
}
#[derive(Default)]
pub struct AuthorizationState {
    gate: Mutex<Gate>,
}
impl AuthorizationState {
    // Conversation wrappers preserve the same gate and origin-window policy.
    pub(crate) fn prepare_for_conversation(&self, owner: &str, store: &TaskStore, effect: Effect, now: Instant) -> Result<Proposal, String> {
        self.prepare(owner, store, effect, now)
    }
    pub(crate) fn approve_for_conversation(&self, owner: &str, id: &str, store: &TaskStore, now: Instant) -> Result<Snapshot, String> {
        self.approve(owner, id, store, now)
    }
    pub(crate) fn cancel_for_conversation(&self, owner: &str, id: Option<&str>) -> Result<(), String> {
        self.cancel(owner, id)
    }
    pub(crate) fn cancel_conversation_proposals(&self) -> Result<(), String> {
        let mut gate = self.gate.lock().map_err(|_| "Autorização indisponível.")?;
        gate.pending.remove("dashboard");
        gate.pending.remove("assistant");
        Ok(())
    }
    fn prepare(
        &self,
        owner: &str,
        store: &TaskStore,
        mut effect: Effect,
        now: Instant,
    ) -> Result<Proposal, String> {
        // Invalidate the former proposal even when replacement validation fails.
        let mut gate = self.gate.lock().map_err(|_| "Autorização indisponível.")?;
        gate.pending.remove(owner);
        let snapshot = store.list()?;
        if snapshot.revision != effect.expected_revision {
            return Err("As tarefas mudaram. Revise o pedido.".into());
        }
        let before = effect
            .id
            .and_then(|id| snapshot.tasks.iter().find(|t| t.id == id).cloned());
        match effect.kind {
            Kind::CreateTask => {
                if effect.id.is_some() || effect.input.is_none() {
                    return Err("Criação inválida.".into());
                }
            }
            Kind::UpdateTask => {
                if before.is_none() || effect.input.is_none() {
                    return Err("Edição inválida.".into());
                }
            }
            Kind::CompleteTask | Kind::DeleteTask => {
                if before.is_none() || effect.input.is_some() {
                    return Err("Operação inválida.".into());
                }
            }
        }
        if let Some(input) = &mut effect.input {
            input.canonicalize()?;
            if let Some(old) = &before {
                if input.description != old.description {
                    return Err("A conversa não altera descrições.".into());
                }
            } else if !input.description.is_empty() {
                return Err("A conversa não cria descrições.".into());
            }
            if effect.kind == Kind::CreateTask
                && snapshot.tasks.iter().any(|t| {
                    !t.completed
                        && t.title.to_lowercase() == input.title.to_lowercase()
                        && t.project.to_lowercase() == input.project.to_lowercase()
                        && t.due_date == input.due_date
                        && t.due_time == input.due_time
                })
            {
                return Err("Já existe uma tarefa equivalente.".into());
            }
        }
        if effect.kind == Kind::CompleteTask && before.as_ref().is_some_and(|t| t.completed) {
            return Err("A tarefa já está concluída.".into());
        }
        gate.sequence = gate
            .sequence
            .checked_add(1)
            .ok_or("Limite de propostas atingido.")?;
        let proposal = Proposal {
            proposal_id: gate.sequence.to_string(),
            effect,
            before,
            expires_in_seconds: 900,
        };
        gate.pending.insert(
            owner.into(),
            Pending {
                proposal: proposal.clone(),
                expires: now + Duration::from_secs(900),
            },
        );
        Ok(proposal)
    }
    fn approve(
        &self,
        owner: &str,
        id: &str,
        store: &TaskStore,
        now: Instant,
    ) -> Result<Snapshot, String> {
        let mut gate = self.gate.lock().map_err(|_| "Autorização indisponível.")?;
        let pending = gate
            .pending
            .get(owner)
            .ok_or("Não há aprovação pendente.")?;
        if pending.proposal.proposal_id != id {
            return Err("A proposta já não está ativa.".into());
        }
        // Consume before any fallible execution. No retry after uncertain writes.
        let pending = gate
            .pending
            .remove(owner)
            .ok_or("Não há aprovação pendente.")?;
        if now >= pending.expires {
            return Err("A aprovação expirou. Repita o pedido.".into());
        }
        let e = pending.proposal.effect;
        // TaskStore checks the exact revision inside the same SQLite transaction
        // as the mutation. Gate remains held through the checked operation.
        match e.kind {
            Kind::CreateTask | Kind::UpdateTask => store.save_checked(
                e.id,
                e.input.ok_or("Dados ausentes.")?.task_input(),
                Some(e.expected_revision),
            ),
            Kind::CompleteTask => store.complete_checked(
                e.id.ok_or("Tarefa ausente.")?,
                true,
                Some(e.expected_revision),
            ),
            Kind::DeleteTask => {
                store.delete_checked(e.id.ok_or("Tarefa ausente.")?, Some(e.expected_revision))
            }
        }
    }
    fn cancel(&self, owner: &str, id: Option<&str>) -> Result<(), String> {
        let mut gate = self.gate.lock().map_err(|_| "Autorização indisponível.")?;
        if id.is_none()
            || gate
                .pending
                .get(owner)
                .is_some_and(|p| Some(p.proposal.proposal_id.as_str()) == id)
        {
            gate.pending.remove(owner);
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn prepare_operation(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<TaskStore>>,
    authorization: State<'_, Arc<AuthorizationState>>,
    effect: Effect,
) -> Result<Proposal, String> {
    let owner = window.label().to_string();
    let store = state.inner().clone();
    let gate = authorization.inner().clone();
    // Preparing stores a review draft, never grants authority or writes tasks.
    tauri::async_runtime::spawn_blocking(move || {
        gate.prepare(&owner, &store, effect, Instant::now())
    })
    .await
    .map_err(|_| "Preparação interrompida.".to_string())?
}
#[tauri::command]
pub async fn approve_operation(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, Arc<TaskStore>>,
    authorization: State<'_, Arc<AuthorizationState>>,
    proposal_id: String,
) -> Result<Snapshot, String> {
    let owner = window.label().to_string();
    let store = state.inner().clone();
    let gate = authorization.inner().clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        gate.approve(&owner, &proposal_id, &store, Instant::now())
    })
    .await
    .map_err(|_| "Operação interrompida. Confira as tarefas antes de repetir.".to_string())??;
    app.emit("tasks-changed", &snapshot)
        .map_err(|_| "Gravação realizada; atualização da interface não confirmada.")?;
    Ok(snapshot)
}
#[tauri::command]
pub fn cancel_operation(
    window: tauri::WebviewWindow,
    authorization: State<'_, Arc<AuthorizationState>>,
    proposal_id: Option<String>,
) -> Result<(), String> {
    authorization.cancel(window.label(), proposal_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        store: TaskStore,
        path: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "jarvis-authorization-{}-{}.sqlite",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            Self {
                store: TaskStore::new(path.clone()),
                path,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
    fn input(title: &str) -> Input {
        Input {
            title: title.into(),
            description: "".into(),
            priority: "normal".into(),
            project: "".into(),
            due_date: None,
            due_time: None,
        }
    }
    fn create(revision: i64) -> Effect {
        Effect {
            kind: Kind::CreateTask,
            id: None,
            input: Some(input("Ensaio fictício")),
            expected_revision: revision,
        }
    }
    #[test]
    fn preparing_never_writes_and_approval_is_exact_and_single_use() {
        let f = Fixture::new();
        let a = AuthorizationState::default();
        let now = Instant::now();
        let p = a.prepare("dashboard", &f.store, create(0), now).unwrap();
        assert_eq!(f.store.list().unwrap().revision, 0);
        assert!(a
            .approve("assistant", &p.proposal_id, &f.store, now)
            .is_err());
        assert!(a.approve("dashboard", "different", &f.store, now).is_err());
        let saved = a
            .approve("dashboard", &p.proposal_id, &f.store, now)
            .unwrap();
        assert_eq!(saved.tasks[0].title, "Ensaio fictício");
        assert!(a
            .approve("dashboard", &p.proposal_id, &f.store, now)
            .is_err());
        assert_eq!(f.store.list().unwrap().revision, 1);
    }
    #[test]
    fn expiry_cancel_and_replacement_never_reuse_authority() {
        let f = Fixture::new();
        let a = AuthorizationState::default();
        let now = Instant::now();
        let first = a.prepare("w", &f.store, create(0), now).unwrap();
        let second = a.prepare("w", &f.store, create(0), now).unwrap();
        assert!(a.approve("w", &first.proposal_id, &f.store, now).is_err());
        a.cancel("w", Some(&first.proposal_id)).unwrap(); // Delayed old cancel cannot remove replacement.
        assert!(a
            .approve(
                "w",
                &second.proposal_id,
                &f.store,
                now + Duration::from_secs(900)
            )
            .is_err());
        assert!(a.approve("w", &second.proposal_id, &f.store, now).is_err());
        let p = a.prepare("w", &f.store, create(0), now).unwrap();
        a.cancel("w", Some(&p.proposal_id)).unwrap();
        assert!(a.approve("w", &p.proposal_id, &f.store, now).is_err());
        assert_eq!(f.store.list().unwrap().revision, 0);
    }
    #[test]
    fn stale_revision_and_failed_write_consume_approval() {
        let f = Fixture::new();
        let a = AuthorizationState::default();
        let now = Instant::now();
        let p = a.prepare("w", &f.store, create(0), now).unwrap();
        f.store
            .save(None, input("Concorrente").task_input())
            .unwrap();
        assert!(a.approve("w", &p.proposal_id, &f.store, now).is_err());
        assert!(a.approve("w", &p.proposal_id, &f.store, now).is_err());
        let mut effect = create(1);
        effect.input.as_mut().unwrap().due_date = Some("2000-01-01".into());
        let p = a.prepare("w", &f.store, effect, now).unwrap();
        assert!(a.approve("w", &p.proposal_id, &f.store, now).is_err());
        assert!(a.approve("w", &p.proposal_id, &f.store, now).is_err());
        assert_eq!(f.store.list().unwrap().tasks.len(), 1);
    }
    #[test]
    fn concrete_operations_cannot_redirect_each_other() {
        let f = Fixture::new();
        let a = AuthorizationState::default();
        let now = Instant::now();
        let c = a.prepare("w", &f.store, create(0), now).unwrap();
        let s = a.approve("w", &c.proposal_id, &f.store, now).unwrap();
        let id = s.tasks[0].id;
        let mut edited = input("Ensaio fictício");
        edited.priority = "high".into();
        let p = a
            .prepare(
                "w",
                &f.store,
                Effect {
                    kind: Kind::UpdateTask,
                    id: Some(id),
                    input: Some(edited),
                    expected_revision: 1,
                },
                now,
            )
            .unwrap();
        let s = a.approve("w", &p.proposal_id, &f.store, now).unwrap();
        assert_eq!(s.tasks[0].priority, "high");
        assert!(!s.tasks[0].completed);
        let p = a
            .prepare(
                "w",
                &f.store,
                Effect {
                    kind: Kind::CompleteTask,
                    id: Some(id),
                    input: None,
                    expected_revision: 2,
                },
                now,
            )
            .unwrap();
        assert!(a.approve("w", &c.proposal_id, &f.store, now).is_err());
        let s = a.approve("w", &p.proposal_id, &f.store, now).unwrap();
        assert!(s.tasks[0].completed);
        let p = a
            .prepare(
                "w",
                &f.store,
                Effect {
                    kind: Kind::DeleteTask,
                    id: Some(id),
                    input: None,
                    expected_revision: 3,
                },
                now,
            )
            .unwrap();
        assert_eq!(f.store.list().unwrap().tasks.len(), 1);
        assert!(a
            .approve("w", &p.proposal_id, &f.store, now)
            .unwrap()
            .tasks
            .is_empty());
    }
    #[test]
    fn rejects_incompatible_shapes_extra_fields_and_duplicates() {
        let f = Fixture::new();
        let a = AuthorizationState::default();
        let now = Instant::now();
        let mut e = create(0);
        e.id = Some(99);
        assert!(a.prepare("w", &f.store, e, now).is_err());
        for kind in [Kind::UpdateTask, Kind::CompleteTask, Kind::DeleteTask] {
            let mut e = create(0);
            e.kind = kind;
            assert!(a.prepare("w", &f.store, e, now).is_err());
        }
        assert!(serde_json::from_str::<Effect>(r#"{"kind":"create_task","id":null,"input":null,"expectedRevision":0,"authorized":true}"#).is_err());
        let p = a.prepare("w", &f.store, create(0), now).unwrap();
        a.approve("w", &p.proposal_id, &f.store, now).unwrap();
        assert!(a.prepare("w", &f.store, create(1), now).is_err());
    }
    #[test]
    fn concurrent_approvals_write_once_and_returned_draft_cannot_redirect() {
        let f = Fixture::new();
        let a = AuthorizationState::default();
        let now = Instant::now();
        let mut p = a.prepare("w", &f.store, create(0), now).unwrap();
        p.effect.input.as_mut().unwrap().title = "Redirecionamento indevido".into();
        let results = std::thread::scope(|scope| {
            let one = scope.spawn(|| a.approve("w", &p.proposal_id, &f.store, now));
            let two = scope.spawn(|| a.approve("w", &p.proposal_id, &f.store, now));
            [one.join().unwrap(), two.join().unwrap()]
        });
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        let saved = f.store.list().unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.tasks[0].title, "Ensaio fictício");
        let bad = Effect {
            kind: Kind::CompleteTask,
            id: Some(saved.tasks[0].id),
            input: Some(input("Extra")),
            expected_revision: 1,
        };
        assert!(a.prepare("w", &f.store, bad, now).is_err());
        assert_eq!(f.store.list().unwrap().revision, 1);
    }
}
