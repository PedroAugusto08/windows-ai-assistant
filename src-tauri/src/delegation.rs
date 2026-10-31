//! M2.1: closed, local, unitary completion authority. No model text is executable.
use crate::tasks::{close_completed_delegations, TaskStore};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, State};

const LIVE: i64 = i64::MIN;
const RETENTION: i64 = 30 * 24 * 60 * 60;
const UNAVAILABLE: &str =
    "Não foi possível consultar ou gravar a delegação. Confira o histórico antes de reenviar.";
fn db(_: rusqlite::Error) -> String {
    UNAVAILABLE.into()
}
fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| UNAVAILABLE.into())
}
fn decode<T: for<'de> Deserialize<'de>>(value: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|_| "Registro de delegação incompatível.".into())
}
fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
fn owner(owner: &str) -> Result<(), String> {
    if matches!(owner, "dashboard" | "assistant") {
        Ok(())
    } else {
        Err("Janela inválida.".into())
    }
}
fn identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        Err("Identificador inválido.".into())
    } else {
        Ok(())
    }
}
fn fresh(conn: &Connection) -> Result<String, String> {
    conn.query_row("SELECT lower(hex(randomblob(32)))", [], |r| r.get(0))
        .map_err(db)
}
#[path = "executor.rs"]
pub mod executor;

pub struct DelegationRuntime {
    epoch: String,
}
impl DelegationRuntime {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            epoch: fresh(&Connection::open_in_memory().map_err(db)?)?,
        })
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub objective: String,
    pub target_ids: Vec<i64>,
    pub max_operations: Option<i64>,
    pub duration_seconds: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub id: i64,
    pub title: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub objective: String,
    pub requester: String,
    pub tool: String,
    pub operation: String,
    pub targets: Vec<Target>,
    pub data: String,
    pub destination: String,
    pub risk: String,
    pub expected_revision: i64,
    pub duration_seconds: i64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub id: String,
    pub version: i64,
    pub owner: String,
    pub status: String,
    pub scope: Option<Scope>,
    pub max_operations: i64,
    pub used: i64,
    pub created_at: i64,
    pub granted_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub ended_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_goal_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Execution {
    pub grant_id: String,
    pub request_id: String,
    pub target_id: i64,
    pub expected_revision: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub request_id: String,
    pub grant_id: String,
    pub owner: String,
    pub target_id: i64,
    pub before_revision: i64,
    pub revision: i64,
    pub used: i64,
    pub committed_at: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub grants: Vec<Grant>,
    pub receipts: Vec<Receipt>,
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS delegation_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
        INSERT OR IGNORE INTO delegation_meta VALUES(1,1);").map_err(db)?;
    let version: i64 = conn
        .query_row("SELECT version FROM delegation_meta WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(db)?;
    if version != 1 {
        return Err("Versão de delegação não suportada.".into());
    }
    conn.execute_batch("CREATE TABLE IF NOT EXISTS delegation_grants (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version=1), epoch TEXT NOT NULL,
        owner TEXT NOT NULL CHECK(owner IN ('dashboard','assistant')),
        status TEXT NOT NULL CHECK(status IN ('draft','active','completed','cancelled','revoked','expired','interrupted')),
        scope TEXT, max_operations INTEGER NOT NULL CHECK(max_operations BETWEEN 1 AND 20),
        used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0 AND used<=max_operations),
        created_at INTEGER NOT NULL, granted_at INTEGER, expires_at INTEGER, ended_at INTEGER);
        CREATE TABLE IF NOT EXISTS delegation_receipts (
        request_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES delegation_grants(id),
        owner TEXT NOT NULL, target_id INTEGER NOT NULL, before_revision INTEGER NOT NULL,
        revision INTEGER NOT NULL UNIQUE, used INTEGER NOT NULL, committed_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS delegation_receipts_grant ON delegation_receipts(grant_id);").map_err(db)
}
fn maintain(conn: &Connection, epoch: &str, time: i64) -> Result<(), String> {
    conn.execute("UPDATE delegation_grants SET status='expired',ended_at=CASE WHEN status='draft' THEN created_at+900 ELSE expires_at END
        WHERE (status='draft' AND created_at+900<=?1) OR (status='active' AND expires_at<=?1)", [time]).map_err(db)?;
    conn.execute("UPDATE delegation_grants SET status='interrupted',ended_at=?1 WHERE status IN ('draft','active') AND epoch<>?2", params![time,epoch]).map_err(db)?;
    conn.execute(
        "UPDATE delegation_grants SET scope=NULL WHERE ended_at IS NOT NULL AND ended_at<=?1",
        [time - RETENTION],
    )
    .map_err(db)?;
    Ok(())
}
fn grant(conn: &Connection, id: &str) -> Result<Grant, String> {
    let (mut g, scope): (Grant, Option<String>) = conn.query_row("SELECT id,version,owner,status,scope,max_operations,used,created_at,granted_at,expires_at,ended_at FROM delegation_grants WHERE id=?1", [id], |r| {
        Ok((Grant { id:r.get(0)?,version:r.get(1)?,owner:r.get(2)?,status:r.get(3)?,scope:None,max_operations:r.get(5)?,used:r.get(6)?,created_at:r.get(7)?,granted_at:r.get(8)?,expires_at:r.get(9)?,ended_at:r.get(10)?,executor_goal_id:None },r.get(4)?))
    }).optional().map_err(db)?.ok_or("Delegação inexistente.")?;
    if g.version != 1 {
        return Err("Versão de concessão não suportada.".into());
    }
    g.scope = scope.map(|s| decode(&s)).transpose()?;
    g.executor_goal_id = executor::binding(conn, id)?;
    Ok(g)
}
fn receipt_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Receipt> {
    Ok(Receipt {
        request_id: r.get(0)?,
        grant_id: r.get(1)?,
        owner: r.get(2)?,
        target_id: r.get(3)?,
        before_revision: r.get(4)?,
        revision: r.get(5)?,
        used: r.get(6)?,
        committed_at: r.get(7)?,
    })
}
const RECEIPTS: &str = "SELECT request_id,grant_id,owner,target_id,before_revision,revision,used,committed_at FROM delegation_receipts";

impl DelegationRuntime {
    fn transaction<T>(
        &self,
        store: &TaskStore,
        time: i64,
        action: impl FnOnce(&Connection, i64) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut conn = store.connect()?;
        conn.pragma_update(None, "foreign_keys", true).map_err(db)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db)?;
        migrate(&tx)?;
        // Read the clock only after admission to SQLite's write serialization.
        let time = if time == LIVE { now() } else { time };
        maintain(&tx, &self.epoch, time)?;
        executor::maintain(&tx, &self.epoch, time)?;
        // Rejected actions must persist lifecycle maintenance but no partial effect.
        tx.execute_batch("SAVEPOINT delegation_action")
            .map_err(db)?;
        let result = action(&tx, time);
        if result.is_err() {
            tx.execute_batch("ROLLBACK TO delegation_action")
                .map_err(db)?;
        }
        tx.execute_batch("RELEASE delegation_action").map_err(db)?;
        tx.commit().map_err(db)?;
        result
    }
    fn prepare(
        &self,
        store: &TaskStore,
        window: &str,
        request: Request,
        time: i64,
    ) -> Result<Grant, String> {
        owner(window)?;
        let objective = request.objective.trim();
        let max = request.max_operations.unwrap_or(20);
        let duration = request.duration_seconds.unwrap_or(1800);
        let mut ids = request.target_ids.clone();
        ids.sort_unstable();
        ids.dedup();
        if objective.is_empty()
            || objective.chars().count() > 500
            || !(1..=20).contains(&max)
            || !(1..=1800).contains(&duration)
            || ids.is_empty()
            || ids.len() > 20
            || ids.len() != request.target_ids.len()
            || ids.iter().any(|id| *id <= 0)
        {
            return Err("Informe objetivo, até 20 alvos distintos, limite de 1 a 20 e prazo de até 30 minutos.".into());
        }
        self.transaction(store, time, |conn, time| {
            self.prepare_on(conn, window, objective, &ids, max, duration, time)
        })
    }
    fn prepare_on(
        &self,
        conn: &Connection,
        window: &str,
        objective: &str,
        ids: &[i64],
        max: i64,
        duration: i64,
        time: i64,
    ) -> Result<Grant, String> {
        let snapshot = TaskStore::read(conn)?;
        let targets = ids
            .iter()
            .map(|id| {
                snapshot
                    .tasks
                    .iter()
                    .find(|t| t.id == *id && !t.completed)
                    .map(|t| Target {
                        id: *id,
                        title: t.title.clone(),
                    })
                    .ok_or_else(|| "Selecione somente tarefas pendentes existentes.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let scope = Scope {
            objective: objective.into(),
            requester: "local_user".into(),
            tool: "tasks".into(),
            operation: "complete_task".into(),
            targets,
            data: "local_task_state".into(),
            destination: "local_sqlite".into(),
            risk: "moderate".into(),
            expected_revision: snapshot.revision,
            duration_seconds: duration,
        };
        let id = fresh(conn)?;
        conn.execute("INSERT INTO delegation_grants(id,version,epoch,owner,status,scope,max_operations,created_at) VALUES(?1,1,?2,?3,'draft',?4,?5,?6)", params![id,self.epoch,window,json(&scope)?,max,time]).map_err(db)?;
        grant(conn, &id)
    }

    fn consent(
        &self,
        store: &TaskStore,
        window: &str,
        id: &str,
        time: i64,
    ) -> Result<Grant, String> {
        owner(window)?;
        identifier(id)?;
        self.transaction(store, time, |conn, time| {
            executor::guard_unitary(conn, id)?;
            self.consent_on(conn, window, id, time)
        })
    }
    fn consent_on(
        &self,
        conn: &Connection,
        window: &str,
        id: &str,
        time: i64,
    ) -> Result<Grant, String> {
        let g = grant(conn, id)?;
        if g.owner != window {
            return Err("Confirme na janela de origem.".into());
        }
        // Exact retry never resets timestamps or budget.
        if g.granted_at.is_some() {
            return Ok(g);
        }
        if g.status != "draft" {
            return Err("Rascunho encerrado. Prepare uma nova delegação.".into());
        }
        let s = g.scope.as_ref().ok_or("Escopo indisponível.")?;
        let snapshot = TaskStore::read(conn)?;
        if snapshot.revision != s.expected_revision
            || s.targets.iter().any(|t| {
                !snapshot
                    .tasks
                    .iter()
                    .any(|task| task.id == t.id && !task.completed)
            })
        {
            return Err("As tarefas mudaram. Revise uma nova delegação.".into());
        }
        conn.execute(
            "UPDATE delegation_grants SET status='active',granted_at=?1,expires_at=?2 WHERE id=?3",
            params![time, time + s.duration_seconds, id],
        )
        .map_err(db)?;
        grant(conn, id)
    }

    fn end(
        &self,
        store: &TaskStore,
        window: &str,
        id: &str,
        reason: &str,
        time: i64,
    ) -> Result<Grant, String> {
        owner(window)?;
        identifier(id)?;
        if !["revoked", "cancelled", "completed"].contains(&reason) {
            return Err("Encerramento inválido.".into());
        }
        self.transaction(store,time,|conn, time| {
            grant(conn,id)?;
            conn.execute("UPDATE delegation_grants SET status=?1,ended_at=?2 WHERE id=?3 AND status IN ('draft','active')",params![reason,time,id]).map_err(db)?;
            grant(conn,id)
        })
    }
    fn history(&self, store: &TaskStore, window: &str, time: i64) -> Result<History, String> {
        owner(window)?;
        self.transaction(store,time,|conn, time| {
            let ids = conn.prepare("SELECT id FROM delegation_grants WHERE status IN ('draft','active') OR id IN (SELECT id FROM delegation_grants WHERE ended_at IS NOT NULL ORDER BY ended_at DESC,id DESC LIMIT 100) ORDER BY created_at DESC,id DESC").map_err(db)?
                .query_map([], |r| r.get::<_,String>(0)).map_err(db)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db)?;
            let grants = ids.iter().map(|id| grant(conn,id)).collect::<Result<Vec<_>,_>>()?;
            let receipts = conn.prepare(&(RECEIPTS.to_owned()+" ORDER BY revision DESC LIMIT 100")).map_err(db)?
                .query_map([],receipt_row).map_err(db)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db)?;
            Ok(History {grants,receipts})
        })
    }
    fn execute(
        &self,
        store: &TaskStore,
        window: &str,
        request: Execution,
        time: i64,
    ) -> Result<Receipt, String> {
        self.execute_inner(store, window, request, time, |_| Ok(()))
    }
    fn execute_inner(
        &self,
        store: &TaskStore,
        window: &str,
        request: Execution,
        time: i64,
        boundary: impl Fn(u8) -> Result<(), String>,
    ) -> Result<Receipt, String> {
        owner(window)?;
        identifier(&request.grant_id)?;
        identifier(&request.request_id)?;
        if request.target_id <= 0 || request.expected_revision < 0 {
            return Err("Operação inválida.".into());
        }
        self.transaction(store, time, |conn, time| {
            self.complete_in_transaction(conn, window, request, time, boundary, false)
        })
    }
    // The only delegated task mutation implementation. Caller owns IMMEDIATE/savepoint.
    fn complete_in_transaction(
        &self,
        conn: &Connection,
        window: &str,
        request: Execution,
        time: i64,
        boundary: impl Fn(u8) -> Result<(), String>,
        from_executor: bool,
    ) -> Result<Receipt, String> {
        if let Some(r) = conn
            .query_row(
                &(RECEIPTS.to_owned() + " WHERE request_id=?1"),
                [&request.request_id],
                receipt_row,
            )
            .optional()
            .map_err(db)?
        {
            if r.grant_id != request.grant_id
                || r.owner != window
                || r.target_id != request.target_id
                || r.before_revision != request.expected_revision
            {
                return Err("Identificador já usado com outros parâmetros.".into());
            }
            return Ok(r);
        }
        if !from_executor {
            executor::guard_unitary(conn, &request.grant_id)?;
            executor::guard_unitary_request(conn, &request.request_id)?;
        }
        let g = grant(conn, &request.grant_id)?;
        if g.owner != window {
            return Err("Execute na janela de origem da delegação.".into());
        }
        if g.status != "active"
            || g.expires_at.is_none_or(|end| time >= end)
            || g.granted_at.is_none_or(|start| time < start)
            || g.used >= g.max_operations
        {
            return Err("Delegação encerrada, expirada ou sem orçamento.".into());
        }
        let s = g.scope.ok_or("Escopo indisponível.")?;
        if s.tool != "tasks"
            || s.operation != "complete_task"
            || s.requester != "local_user"
            || s.data != "local_task_state"
            || s.destination != "local_sqlite"
            || s.risk != "moderate"
            || !s.targets.iter().any(|t| t.id == request.target_id)
        {
            return Err("Operação fora da concessão.".into());
        }
        let snapshot = TaskStore::read(conn)?;
        if snapshot.revision != request.expected_revision {
            return Err("As tarefas mudaram. Atualize antes de executar.".into());
        }
        if !snapshot
            .tasks
            .iter()
            .any(|t| t.id == request.target_id && !t.completed)
        {
            return Err("Tarefa ausente ou já concluída.".into());
        }
        boundary(0)?;
        let used = g.used + 1;
        conn.execute(
            "UPDATE delegation_grants SET used=?1 WHERE id=?2",
            params![used, request.grant_id],
        )
        .map_err(db)?;
        boundary(1)?;
        let count = conn
            .execute(
                "UPDATE tasks SET completed=1 WHERE id=?1 AND completed=0",
                [request.target_id],
            )
            .map_err(db)?;
        if count != 1 {
            return Err("Efeito não confirmado.".into());
        }
        boundary(2)?;
        conn.execute("UPDATE task_meta SET revision=revision+1 WHERE id=1", [])
            .map_err(db)?;
        let revision: i64 = conn
            .query_row("SELECT revision FROM task_meta WHERE id=1", [], |r| {
                r.get(0)
            })
            .map_err(db)?;
        if revision
            != request
                .expected_revision
                .checked_add(1)
                .ok_or("Revisão inválida.")?
        {
            return Err("Revisão inválida.".into());
        }
        boundary(3)?;
        conn.execute(
            "INSERT INTO delegation_receipts VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                request.request_id,
                request.grant_id,
                window,
                request.target_id,
                request.expected_revision,
                revision,
                used,
                time
            ],
        )
        .map_err(db)?;
        boundary(4)?;
        close_completed_delegations(conn, time)?;
        if used == g.max_operations {
            conn.execute(
                "UPDATE delegation_grants SET status='completed',ended_at=?1 WHERE id=?2",
                params![time, request.grant_id],
            )
            .map_err(db)?;
        }
        boundary(5)?;
        Ok(Receipt {
            request_id: request.request_id,
            grant_id: request.grant_id,
            owner: window.into(),
            target_id: request.target_id,
            before_revision: request.expected_revision,
            revision,
            used,
            committed_at: time,
        })
    }
}

#[tauri::command]
pub async fn delegation_prepare(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: State<'_, Arc<TaskStore>>,
    runtime: State<'_, Arc<DelegationRuntime>>,
    request: Request,
) -> Result<Grant, String> {
    let owner = window.label().to_string();
    let store = store.inner().clone();
    let runtime = runtime.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        runtime.prepare(&store, &owner, request, LIVE)
    })
    .await
    .map_err(|_| UNAVAILABLE.to_string())?;
    let _ = app.emit("delegation-changed", ());
    result
}
#[tauri::command]
pub async fn delegation_consent(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: State<'_, Arc<TaskStore>>,
    runtime: State<'_, Arc<DelegationRuntime>>,
    grant_id: String,
) -> Result<Grant, String> {
    let owner = window.label().to_string();
    let store = store.inner().clone();
    let runtime = runtime.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        runtime.consent(&store, &owner, &grant_id, LIVE)
    })
    .await
    .map_err(|_| UNAVAILABLE.to_string())?;
    let _ = app.emit("delegation-changed", ());
    result
}
#[tauri::command]
pub async fn delegation_end(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: State<'_, Arc<TaskStore>>,
    runtime: State<'_, Arc<DelegationRuntime>>,
    grant_id: String,
    reason: String,
) -> Result<Grant, String> {
    let owner = window.label().to_string();
    let store = store.inner().clone();
    let runtime = runtime.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        runtime.end(&store, &owner, &grant_id, &reason, LIVE)
    })
    .await
    .map_err(|_| UNAVAILABLE.to_string())?;
    let _ = app.emit("delegation-changed", ());
    result
}
#[tauri::command]
pub async fn delegation_history(
    window: tauri::WebviewWindow,
    store: State<'_, Arc<TaskStore>>,
    runtime: State<'_, Arc<DelegationRuntime>>,
) -> Result<History, String> {
    let owner = window.label().to_string();
    let store = store.inner().clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.history(&store, &owner, LIVE))
        .await
        .map_err(|_| UNAVAILABLE.to_string())?
}
#[tauri::command]
pub async fn delegation_execute(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: State<'_, Arc<TaskStore>>,
    runtime: State<'_, Arc<DelegationRuntime>>,
    request: Execution,
) -> Result<Receipt, String> {
    let owner = window.label().to_string();
    let store = store.inner().clone();
    let runtime = runtime.inner().clone();
    let event_store = store.clone();
    let receipt = tauri::async_runtime::spawn_blocking(move || {
        runtime.execute(&store, &owner, request, LIVE)
    })
    .await
    .map_err(|_| UNAVAILABLE.to_string())??;
    // A delivery failure cannot turn a committed result into permission to retry.
    if let Ok(Ok(snapshot)) = tauri::async_runtime::spawn_blocking(move || event_store.list()).await
    {
        let _ = app.emit("tasks-changed", snapshot);
    }
    let _ = app.emit("delegation-changed", ());
    Ok(receipt)
}

#[cfg(test)]
#[path = "delegation-tests.rs"]
mod tests;
