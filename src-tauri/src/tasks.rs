use chrono::{DateTime, Local, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: i64,
    pub title: String,
    pub description: String,
    pub priority: String,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub project: String,
    pub completed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "normal")]
    pub priority: String,
    pub due_date: Option<String>,
    #[serde(default)]
    pub due_time: Option<String>,
    #[serde(default)]
    pub project: String,
}
fn normal() -> String {
    "normal".into()
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub revision: i64,
    pub tasks: Vec<Task>,
}

// O arquivo é aberto sob demanda: falhas não impedem o desktop de iniciar e podem ser retentadas.
pub struct TaskStore {
    path: PathBuf,
    gate: Mutex<()>,
}
impl TaskStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            gate: Mutex::new(()),
        }
    }
    pub(crate) fn connect(&self) -> Result<Connection, String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| "Não foi possível abrir a pasta de tarefas.".to_string())?;
        }
        let mut conn = Connection::open(&self.path)
            .map_err(|_| "Não foi possível abrir o banco de tarefas.".to_string())?;
        conn.busy_timeout(Duration::from_secs(3))
            .map_err(db_error)?;
        // Migração aditiva e transacional: tarefas legadas recebem due_time=NULL.
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS task_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
            INSERT OR IGNORE INTO task_meta VALUES (1,0);
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL CHECK(length(trim(title))>0),
                description TEXT NOT NULL, priority TEXT NOT NULL CHECK(priority IN ('low','normal','high')),
                due_date TEXT, due_time TEXT, project TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)));").map_err(db_error)?;
        let has_due_time = {
            let mut columns = tx.prepare("PRAGMA table_info(tasks)").map_err(db_error)?;
            let names = columns
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(db_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(db_error)?;
            names.iter().any(|column| column == "due_time")
        };
        if !has_due_time {
            tx.execute("ALTER TABLE tasks ADD COLUMN due_time TEXT", [])
                .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(conn)
    }
    pub(crate) fn read(conn: &Connection) -> Result<Snapshot, String> {
        let revision = conn
            .query_row("SELECT revision FROM task_meta WHERE id=1", [], |r| {
                r.get(0)
            })
            .map_err(db_error)?;
        let mut query = conn.prepare("SELECT id,title,description,priority,due_date,due_time,project,completed FROM tasks ORDER BY id").map_err(db_error)?;
        let tasks = query
            .query_map([], |r| {
                Ok(Task {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    description: r.get(2)?,
                    priority: r.get(3)?,
                    due_date: r.get(4)?,
                    due_time: r.get(5)?,
                    project: r.get(6)?,
                    completed: r.get(7)?,
                })
            })
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        Ok(Snapshot { revision, tasks })
    }
    pub fn list(&self) -> Result<Snapshot, String> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| "Banco de tarefas indisponível.".to_string())?;
        let mut conn = self.connect()?;
        let tx = conn.transaction().map_err(db_error)?;
        Self::read(&tx)
    }
    fn mutate(
        &self,
        expected_revision: Option<i64>,
        op: impl FnOnce(&Connection) -> Result<(), String>,
    ) -> Result<Snapshot, String> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| "Banco de tarefas indisponível.".to_string())?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        if let Some(expected) = expected_revision {
            let revision: i64 = tx
                .query_row("SELECT revision FROM task_meta WHERE id=1", [], |r| {
                    r.get(0)
                })
                .map_err(db_error)?;
            if revision != expected {
                return Err(
                    "As tarefas mudaram. Repita o pedido para selecionar e confirmar novamente."
                        .into(),
                );
            }
        }
        op(&tx)?;
        close_completed_delegations(&tx, Utc::now().timestamp())?;
        tx.execute("UPDATE task_meta SET revision=revision+1 WHERE id=1", [])
            .map_err(db_error)?;
        let snapshot = Self::read(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(snapshot)
    }
    pub fn save(&self, id: Option<i64>, input: TaskInput) -> Result<Snapshot, String> {
        self.save_checked(id, input, None)
    }
    pub fn save_checked(
        &self,
        id: Option<i64>,
        input: TaskInput,
        expected_revision: Option<i64>,
    ) -> Result<Snapshot, String> {
        let title = input.title.trim();
        if title.is_empty() || title.chars().count() > 200 {
            return Err("Informe um título com até 200 caracteres.".into());
        }
        if input.description.chars().count() > 5000 || input.project.chars().count() > 100 {
            return Err("Descrição ou projeto muito longo.".into());
        }
        if !["low", "normal", "high"].contains(&input.priority.as_str()) {
            return Err("Prioridade inválida.".into());
        }
        validate_deadline_parts(input.due_date.as_deref(), input.due_time.as_deref())?;
        self.mutate(expected_revision, |conn| {
            let unchanged_deadline = if let Some(id) = id {
                let old = conn.query_row(
                    "SELECT due_date,due_time FROM tasks WHERE id=?1", [id],
                    |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
                ).optional().map_err(db_error)?.ok_or_else(|| "A tarefa não existe mais. Atualize a lista.".to_string())?;
                old == (input.due_date.clone(), input.due_time.clone())
            } else { false };
            if !unchanged_deadline {
                validate_future_deadline(input.due_date.as_deref(), input.due_time.as_deref(), Utc::now())?;
            }
            if let Some(id) = id {
                let count = conn.execute(
                    "UPDATE tasks SET title=?1,description=?2,priority=?3,due_date=?4,due_time=?5,project=?6 WHERE id=?7",
                    params![title,input.description.trim(),input.priority,input.due_date,input.due_time,input.project.trim(),id],
                ).map_err(db_error)?;
                exists(count)?;
            } else {
                conn.execute(
                    "INSERT INTO tasks (title,description,priority,due_date,due_time,project) VALUES (?1,?2,?3,?4,?5,?6)",
                    params![title,input.description.trim(),input.priority,input.due_date,input.due_time,input.project.trim()],
                ).map_err(db_error)?;
            }
            Ok(())
        })
    }
    pub fn complete(&self, id: i64, completed: bool) -> Result<Snapshot, String> {
        self.complete_checked(id, completed, None)
    }
    pub fn complete_checked(
        &self,
        id: i64,
        completed: bool,
        expected_revision: Option<i64>,
    ) -> Result<Snapshot, String> {
        self.mutate(expected_revision, |conn| {
            exists(
                conn.execute(
                    "UPDATE tasks SET completed=?1 WHERE id=?2",
                    params![completed, id],
                )
                .map_err(db_error)?,
            )
        })
    }
    pub fn delete(&self, id: i64) -> Result<Snapshot, String> {
        self.delete_checked(id, None)
    }
    pub fn delete_checked(
        &self,
        id: i64,
        expected_revision: Option<i64>,
    ) -> Result<Snapshot, String> {
        self.mutate(expected_revision, |conn| {
            exists(
                conn.execute("DELETE FROM tasks WHERE id=?1", [id])
                    .map_err(db_error)?,
            )
        })
    }
}
// Task effects from either v1/manual commands or delegated execution close all
// matching objectives atomically, before a later reopen could reuse authority.
// This helper does not depend on the executor module, preserving the legacy entry.
#[derive(Deserialize)]
struct CompletionScope {
    operation: String,
    targets: Vec<CompletionTarget>,
}
#[derive(Deserialize)]
struct CompletionTarget { id: i64 }
pub(crate) fn close_completed_delegations(conn: &Connection, time: i64) -> Result<(), String> {
    let present: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='delegation_grants')",
        [], |row| row.get(0),
    ).map_err(db_error)?;
    if !present { return Ok(()); }
    // Expiration precedes a later explicit completion and retains its real end time.
    conn.execute("UPDATE delegation_grants SET status='expired',ended_at=expires_at WHERE status='active' AND expires_at<=?1", [time])
        .map_err(db_error)?;
    let grants = conn.prepare("SELECT id,scope FROM delegation_grants WHERE status='active' AND version=1")
        .map_err(db_error)?.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))
        .map_err(db_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)?;
    for (id, raw) in grants {
        let scope: CompletionScope = serde_json::from_str(&raw).map_err(|_| "Escopo de delegação inválido; alteração não confirmada.".to_string())?;
        if scope.operation != "complete_task" || scope.targets.is_empty() { continue; }
        let mut complete = true;
        for target in scope.targets {
            let done = conn.query_row("SELECT completed FROM tasks WHERE id=?1", [target.id], |row| row.get::<_,bool>(0))
                .optional().map_err(db_error)?;
            if done != Some(true) { complete = false; break; }
        }
        if complete {
            conn.execute("UPDATE delegation_grants SET status='completed',ended_at=?1 WHERE id=?2 AND status='active'", params![time,id])
                .map_err(db_error)?;
        }
    }
    Ok(())
}
fn validate_deadline_parts(date: Option<&str>, time: Option<&str>) -> Result<(), String> {
    if date.is_none() && time.is_some() {
        return Err("Informe uma data para associar ao horário.".into());
    }
    if let Some(value) = date {
        if !valid_date(value) {
            return Err("Prazo inválido. Informe uma data válida.".into());
        }
    }
    if let Some(value) = time {
        if value.len() != 5
            || value.as_bytes().get(2) != Some(&b':')
            || !value
                .bytes()
                .enumerate()
                .all(|(i, byte)| i == 2 || byte.is_ascii_digit())
            || NaiveTime::parse_from_str(value, "%H:%M").is_err()
        {
            return Err("Horário inválido. Use o formato HH:MM.".into());
        }
    }
    Ok(())
}
fn local_deadline(date: &str, time: Option<&str>) -> Result<DateTime<Utc>, String> {
    let day = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| "Prazo inválido. Informe uma data válida.".to_string())?;
    let clock = if let Some(time) = time {
        NaiveTime::parse_from_str(time, "%H:%M")
            .map_err(|_| "Horário inválido. Use o formato HH:MM.".to_string())?
    } else {
        NaiveTime::from_hms_nano_opt(23, 59, 59, 999_999_999)
            .ok_or_else(|| "Prazo inválido.".to_string())?
    };
    let local = NaiveDateTime::new(day, clock);
    match Local.from_local_datetime(&local) {
        LocalResult::Single(value) => Ok(value.with_timezone(&Utc)),
        LocalResult::Ambiguous(earliest, _) => Ok(earliest.with_timezone(&Utc)),
        LocalResult::None => {
            Err("Esse horário local não existe por causa da mudança de horário.".into())
        }
    }
}
fn validate_future_deadline(
    date: Option<&str>,
    time: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), String> {
    validate_deadline_parts(date, time)?;
    if let Some(date) = date {
        if local_deadline(date, time)? <= now {
            return Err("O prazo informado já passou. Escolha uma data e horário futuros.".into());
        }
    }
    Ok(())
}
fn exists(count: usize) -> Result<(), String> {
    if count == 1 {
        Ok(())
    } else {
        Err("A tarefa não existe mais. Atualize a lista.".into())
    }
}
fn db_error(_: rusqlite::Error) -> String {
    "Não foi possível ler ou gravar as tarefas. Tente novamente; os dados existentes foram preservados.".into()
}
fn valid_date(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 10
        || b[4] != b'-'
        || b[7] != b'-'
        || b.iter()
            .enumerate()
            .any(|(i, c)| i != 4 && i != 7 && !c.is_ascii_digit())
    {
        return false;
    }
    let y = value[..4].parse::<u32>().unwrap_or(0);
    let m = value[5..7].parse::<usize>().unwrap_or(0);
    let d = value[8..].parse::<u32>().unwrap_or(0);
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    y > 0
        && (1..=12).contains(&m)
        && d > 0
        && d <= [
            31,
            if leap { 29 } else { 28 },
            31,
            30,
            31,
            30,
            31,
            31,
            30,
            31,
            30,
            31,
        ][m.saturating_sub(1).min(11)]
}
fn publish(app: &tauri::AppHandle, snapshot: Snapshot) -> Snapshot {
    // O commit já ocorreu. Falha de emissão não deve induzir uma segunda criação.
    if let Err(error) = app.emit("tasks-changed", &snapshot) {
        eprintln!("Falha ao comunicar tarefas: {error}");
    }
    snapshot
}
#[tauri::command]
pub async fn list_tasks(store: State<'_, Arc<TaskStore>>) -> Result<Snapshot, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.list())
        .await
        .map_err(|_| "Operação de tarefas interrompida.".to_string())?
}
#[tauri::command]
pub async fn save_task(
    app: tauri::AppHandle,
    store: State<'_, Arc<TaskStore>>,
    id: Option<i64>,
    input: TaskInput,
    expected_revision: Option<i64>,
) -> Result<Snapshot, String> {
    let store = store.inner().clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || match expected_revision {
        Some(revision) => store.save_checked(id, input, Some(revision)),
        None => store.save(id, input),
    })
    .await
    .map_err(|_| "Operação de tarefas interrompida.".to_string())??;
    Ok(publish(&app, snapshot))
}
#[tauri::command]
pub async fn complete_task(
    app: tauri::AppHandle,
    store: State<'_, Arc<TaskStore>>,
    id: i64,
    completed: bool,
    expected_revision: Option<i64>,
) -> Result<Snapshot, String> {
    let store = store.inner().clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || match expected_revision {
        Some(revision) => store.complete_checked(id, completed, Some(revision)),
        None => store.complete(id, completed),
    })
    .await
    .map_err(|_| "Operação de tarefas interrompida.".to_string())??;
    Ok(publish(&app, snapshot))
}
#[tauri::command]
pub async fn delete_task(
    app: tauri::AppHandle,
    store: State<'_, Arc<TaskStore>>,
    id: i64,
    expected_revision: Option<i64>,
) -> Result<Snapshot, String> {
    let store = store.inner().clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || match expected_revision {
        Some(revision) => store.delete_checked(id, Some(revision)),
        None => store.delete(id),
    })
    .await
    .map_err(|_| "Operação de tarefas interrompida.".to_string())??;
    Ok(publish(&app, snapshot))
}
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(Arc::new(TaskStore::new(
        app.path().app_local_data_dir()?.join("tasks.sqlite3"),
    )));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(title: &str) -> TaskInput {
        TaskInput {
            title: title.into(),
            description: String::new(),
            priority: normal(),
            due_date: None,
            due_time: None,
            project: String::new(),
        }
    }
    fn path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "jarvis-tasks-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    #[test]
    fn checked_writes_reject_stale_selection_and_replay() {
        let path = path();
        let store = TaskStore::new(path.clone());
        let created = store.save_checked(None, input("Estudar"), Some(0)).unwrap();
        let id = created.tasks[0].id;
        assert!(store
            .save_checked(None, input("Duplicada"), Some(0))
            .is_err());
        assert!(store.complete_checked(id, true, Some(0)).is_err());
        assert!(store.delete_checked(id, Some(0)).is_err());
        assert_eq!(store.list().unwrap().tasks, created.tasks);
        let done = store
            .complete_checked(id, true, Some(created.revision))
            .unwrap();
        assert!(store.delete_checked(id, Some(created.revision)).is_err());
        let deleted = store.delete_checked(id, Some(done.revision)).unwrap();
        assert!(deleted.tasks.is_empty());
        assert!(store.delete_checked(id, Some(done.revision)).is_err());
        assert_eq!(
            TaskStore::new(path.clone()).list().unwrap().revision,
            deleted.revision
        );
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn lifecycle_survives_reopen() {
        let path = path();
        let store = TaskStore::new(path.clone());
        let created = store.save(None, input("  Primeira  ")).unwrap();
        let id = created.tasks[0].id;
        assert_eq!(created.tasks[0].title, "Primeira");
        assert_eq!(created.tasks[0].priority, "normal");
        let mut edit = input("Editada");
        edit.description = "Descrição".into();
        edit.priority = "high".into();
        edit.project = "JARVIS".into();
        edit.due_date = Some("2028-02-29".into());
        store.save(Some(id), edit).unwrap();
        store.complete(id, true).unwrap();
        drop(store);
        let reopened = TaskStore::new(path.clone());
        let snapshot = reopened.list().unwrap();
        assert_eq!(snapshot.revision, 3);
        assert_eq!(snapshot.tasks[0].id, id);
        assert!(snapshot.tasks[0].completed);
        assert_eq!(snapshot.tasks[0].due_date, Some("2028-02-29".into()));
        assert_eq!(snapshot.tasks[0].project, "JARVIS");
        reopened.complete(id, false).unwrap();
        assert!(!reopened.list().unwrap().tasks[0].completed);
        reopened.delete(id).unwrap();
        assert!(reopened.list().unwrap().tasks.is_empty());
        assert!(reopened.save(None, input("Outra")).unwrap().tasks[0].id > id);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn invalid_writes_preserve_data_and_revision() {
        let path = path();
        let store = TaskStore::new(path.clone());
        store.save(None, input("Original")).unwrap();
        assert!(store.save(None, input(" ")).is_err());
        let mut bad = input("Erro");
        bad.due_date = Some("2026-02-29".into());
        assert!(store.save(None, bad).is_err());
        let mut bad = input("Erro");
        bad.priority = "urgent".into();
        assert!(store.save(None, bad).is_err());
        assert!(store.delete(999).is_err());
        assert!(store.save(Some(999), input("Erro")).is_err());
        assert!(store.complete(999, true).is_err());
        assert_eq!(store.list().unwrap().revision, 1);
        assert_eq!(store.list().unwrap().tasks[0].title, "Original");
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn unreadable_database_is_not_reset() {
        let path = path();
        std::fs::write(&path, b"invalid database").unwrap();
        let store = TaskStore::new(path.clone());
        assert!(store.list().is_err());
        assert!(store.save(None, input("Erro")).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"invalid database");
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn locked_write_is_reported_without_commit() {
        let path = path();
        let store = TaskStore::new(path.clone());
        store.save(None, input("Original")).unwrap();
        let mut conn = store.connect().unwrap();
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(store.save(None, input("Erro")).is_err());
        drop(tx);
        drop(conn);
        assert_eq!(store.list().unwrap().revision, 1);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn simultaneous_connections_preserve_both_writes() {
        let path = path();
        TaskStore::new(path.clone()).list().unwrap();
        std::thread::scope(|scope| {
            let first = path.clone();
            let second = path.clone();
            scope.spawn(move || TaskStore::new(first).save(None, input("Primeira")).unwrap());
            scope.spawn(move || TaskStore::new(second).save(None, input("Segunda")).unwrap());
        });
        let snapshot = TaskStore::new(path.clone()).list().unwrap();
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.tasks.len(), 2);
        assert_ne!(snapshot.tasks[0].id, snapshot.tasks[1].id);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn legacy_database_migrates_without_losing_tasks_or_revision() {
        let path = path();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE task_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
            INSERT INTO task_meta VALUES (1,7);
            CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,description TEXT NOT NULL,priority TEXT NOT NULL,due_date TEXT,project TEXT NOT NULL,completed INTEGER NOT NULL);
            INSERT INTO tasks VALUES (41,'Legada','Mantida','high','2000-02-29','Projeto antigo',0);").unwrap();
        drop(conn);
        let store = TaskStore::new(path.clone());
        let migrated = store.list().unwrap();
        assert_eq!(migrated.revision, 7);
        assert_eq!(migrated.tasks.len(), 1);
        assert_eq!(
            migrated.tasks[0],
            Task {
                id: 41,
                title: "Legada".into(),
                description: "Mantida".into(),
                priority: "high".into(),
                due_date: Some("2000-02-29".into()),
                due_time: None,
                project: "Projeto antigo".into(),
                completed: false
            }
        );
        let mut edit = input("Atualizada");
        edit.due_date = Some("2000-02-29".into());
        store.save(Some(41), edit).unwrap();
        assert_eq!(store.list().unwrap().tasks[0].title, "Atualizada");
        assert_eq!(store.list().unwrap().tasks[0].due_time, None);
        assert!(store.complete(41, true).unwrap().tasks[0].completed);
        drop(store);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn local_deadlines_accept_future_date_and_time_and_reject_expired_values() {
        let tomorrow = Local::now().date_naive().succ_opt().unwrap();
        let date = tomorrow.format("%Y-%m-%d").to_string();
        let timed = local_deadline(&date, Some("23:58")).unwrap();
        assert!(timed > Utc::now());
        validate_future_deadline(Some(&date), Some("23:58"), Utc::now()).unwrap();
        let end_of_day = local_deadline(&date, None).unwrap();
        assert!(end_of_day > timed);
        validate_future_deadline(Some(&date), None, Utc::now()).unwrap();
        assert!(validate_deadline_parts(None, Some("09:00"))
            .unwrap_err()
            .contains("data"));
        assert!(validate_deadline_parts(Some(&date), Some("24:00"))
            .unwrap_err()
            .contains("Horário"));
        assert!(validate_deadline_parts(Some(&date), Some("9:00"))
            .unwrap_err()
            .contains("Horário"));
        assert!(validate_future_deadline(Some(&date), Some("23:58"), timed)
            .unwrap_err()
            .contains("passou"));
        assert!(
            validate_future_deadline(Some("2000-02-29"), None, Utc::now())
                .unwrap_err()
                .contains("passou")
        );
    }
    #[test]
    fn adding_or_changing_deadline_is_validated_but_unchanged_overdue_deadline_is_editable() {
        let path = path();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE task_meta (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); INSERT INTO task_meta VALUES(1,0);
            CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,description TEXT NOT NULL,priority TEXT NOT NULL,due_date TEXT,due_time TEXT,project TEXT NOT NULL,completed INTEGER NOT NULL);
            INSERT INTO tasks VALUES(5,'Atrasada','','normal','2000-02-29','09:30','',0);").unwrap();
        drop(conn);
        let store = TaskStore::new(path.clone());
        store.list().unwrap();
        let mut unchanged = input("Atrasada editada");
        unchanged.due_date = Some("2000-02-29".into());
        unchanged.due_time = Some("09:30".into());
        assert_eq!(
            store.save(Some(5), unchanged).unwrap().tasks[0].title,
            "Atrasada editada"
        );
        let mut changed = input("Atrasada editada");
        changed.due_date = Some(
            Local::now()
                .date_naive()
                .pred_opt()
                .unwrap()
                .format("%Y-%m-%d")
                .to_string(),
        );
        changed.due_time = Some("09:30".into());
        assert!(store.save(Some(5), changed).unwrap_err().contains("passou"));
        assert!(store.complete(5, true).unwrap().tasks[0].completed);
        let mut completed_edit = input("Atrasada concluída editada");
        completed_edit.due_date = Some("2000-02-29".into());
        completed_edit.due_time = Some("09:30".into());
        let saved = store.save(Some(5), completed_edit).unwrap().tasks.remove(0);
        assert!(saved.completed);
        assert_eq!(saved.title, "Atrasada concluída editada");
        drop(store);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn calendar_dates() {
        for value in ["2024-02-29", "2000-02-29", "2026-12-31"] {
            assert!(valid_date(value));
        }
        for value in [
            "1900-02-29",
            "0000-01-01",
            "2026-04-31",
            "2026-13-01",
            "éééé-01",
            "2026-1-01",
        ] {
            assert!(!valid_date(value));
        }
    }
}
