//! Durable M2.2 coordinator. All task effects use the M2.1 transaction body.
use super::*;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    CompleteTask,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    pub id: String,
    pub operation: Operation,
    pub target_id: i64,
    pub depends_on: Vec<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proposal {
    pub objective: String,
    pub steps: Vec<Step>,
    pub max_operations: Option<i64>,
    pub duration_seconds: Option<i64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub steps: Vec<Step>,
    pub targets: Vec<Target>,
    #[serde(default)]
    pub omitted_steps: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepState {
    pub id: String,
    pub status: String,
    pub receipt: Option<Receipt>,
    pub current_task_state: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptRecord {
    pub request_id: String,
    pub plan_revision: i64,
    pub step_id: String,
    pub status: String,
    pub created_at: i64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub objective: Option<String>,
    pub owner: String,
    pub status: String,
    pub plan_revision: i64,
    pub expected_revision: i64,
    pub consumed: i64,
    pub budget: i64,
    pub reason: Option<String>,
    pub plan: Option<Plan>,
    pub grant: Grant,
    pub steps: Vec<StepState>,
    pub attempts: Vec<AttemptRecord>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: i64,
    pub goals: Vec<Goal>,
}
#[derive(Clone, Debug)]
struct Attempt {
    key: String,
    goal: String,
    plan: i64,
    step: String,
    execution: Execution,
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS executor_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO executor_meta VALUES(1,1,0);
        CREATE TABLE IF NOT EXISTS executor_goals(
        id TEXT PRIMARY KEY,objective TEXT,owner TEXT NOT NULL,epoch TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','ready','running','blocked','interrupted','cancelled','completed','revoked')),
        plan_revision INTEGER NOT NULL,expected_revision INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,
        budget INTEGER NOT NULL CHECK(budget BETWEEN 1 AND 20),reason TEXT,created_at INTEGER NOT NULL,ended_at INTEGER,
        CHECK(consumed BETWEEN 0 AND budget));
        CREATE UNIQUE INDEX IF NOT EXISTS executor_one_active ON executor_goals((1)) WHERE status IN ('ready','running');
        CREATE TABLE IF NOT EXISTS executor_plans(
        goal_id TEXT NOT NULL REFERENCES executor_goals(id),revision INTEGER NOT NULL,body TEXT,
        grant_id TEXT NOT NULL UNIQUE REFERENCES delegation_grants(id),created_at INTEGER NOT NULL,
        PRIMARY KEY(goal_id,revision));
        CREATE TABLE IF NOT EXISTS executor_steps(
        goal_id TEXT NOT NULL REFERENCES executor_goals(id),step_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','admitted','succeeded','omitted')),
        receipt_id TEXT UNIQUE REFERENCES delegation_receipts(request_id),PRIMARY KEY(goal_id,step_id));
        CREATE TABLE IF NOT EXISTS executor_attempts(
        request_id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,plan_revision INTEGER NOT NULL,step_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,target_id INTEGER NOT NULL,expected_revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('admitted','succeeded','not_committed','uncertain')),created_at INTEGER NOT NULL,
        FOREIGN KEY(goal_id,plan_revision) REFERENCES executor_plans(goal_id,revision),
        FOREIGN KEY(goal_id,step_id) REFERENCES executor_steps(goal_id,step_id));
        CREATE UNIQUE INDEX IF NOT EXISTS executor_one_admitted ON executor_attempts(goal_id) WHERE status='admitted';
        CREATE TRIGGER IF NOT EXISTS executor_plan_immutable BEFORE UPDATE ON executor_plans
        WHEN NEW.goal_id<>OLD.goal_id OR NEW.revision<>OLD.revision OR NEW.grant_id<>OLD.grant_id OR NEW.created_at<>OLD.created_at
        OR (NEW.body IS NOT NULL AND NEW.body IS NOT OLD.body)
        BEGIN SELECT RAISE(ABORT,'immutable plan'); END;").map_err(db)?;
    let v: i64 = conn
        .query_row("SELECT version FROM executor_meta WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(db)?;
    if v != 1 {
        return Err("Versão de executor incompatível.".into());
    }
    Ok(())
}
fn touch(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE executor_meta SET revision=revision+1 WHERE id=1",
        [],
    )
    .map_err(db)?;
    Ok(())
}
pub(super) fn maintain(conn: &Connection, epoch: &str, time: i64) -> Result<(), String> {
    migrate(conn)?;
    let before = conn.total_changes();
    conn.execute("UPDATE executor_goals SET status='interrupted',ended_at=MIN(COALESCE(ended_at,?2),COALESCE((SELECT d.ended_at FROM executor_plans p JOIN delegation_grants d ON d.id=p.grant_id WHERE p.goal_id=executor_goals.id AND p.revision=executor_goals.plan_revision),?2)),reason='Reinício: execução interrompida. Revise o restante e conceda novamente.'
        WHERE epoch<>?1 AND status NOT IN ('completed','cancelled','revoked','interrupted')",params![epoch,time]).map_err(db)?;
    conn.execute("UPDATE executor_goals SET status='blocked',ended_at=COALESCE((SELECT d.ended_at FROM executor_plans p JOIN delegation_grants d ON d.id=p.grant_id WHERE p.goal_id=executor_goals.id AND p.revision=executor_goals.plan_revision),?1),reason='Autoridade encerrada. Confira as etapas e revise o restante.'
        WHERE status IN ('draft','ready','running') AND EXISTS(SELECT 1 FROM executor_plans p JOIN delegation_grants g ON g.id=p.grant_id
        WHERE p.goal_id=executor_goals.id AND p.revision=executor_goals.plan_revision AND g.status NOT IN ('active','draft'))",[time]).map_err(db)?;
    // Atomic receipts prove whether a local effect committed. These goals have no live
    // authority, so reconciliation cannot race an admitted effect into a new mutation.
    conn.execute("UPDATE executor_attempts SET status='not_committed' WHERE status='admitted' AND goal_id IN
        (SELECT id FROM executor_goals WHERE status IN ('interrupted','blocked','cancelled','revoked'))
        AND NOT EXISTS(SELECT 1 FROM delegation_receipts r WHERE r.request_id=executor_attempts.request_id AND r.grant_id=executor_attempts.grant_id AND r.target_id=executor_attempts.target_id AND r.before_revision=executor_attempts.expected_revision AND r.owner=(SELECT owner FROM executor_goals WHERE id=executor_attempts.goal_id))",[]).map_err(db)?;
    conn.execute("UPDATE executor_steps SET status='pending' WHERE status='admitted' AND goal_id IN
        (SELECT id FROM executor_goals WHERE status IN ('interrupted','blocked','cancelled','revoked'))",[]).map_err(db)?;
    // Only terminal goals lose details; IDs, attempt tuples and receipts remain tombstones.
    conn.execute(
        "UPDATE executor_plans SET body=NULL WHERE body IS NOT NULL AND goal_id IN
        (SELECT id FROM executor_goals WHERE ended_at IS NOT NULL AND ended_at<=?1)",
        [time - RETENTION],
    )
    .map_err(db)?;
    conn.execute("UPDATE executor_goals SET objective=NULL,reason=NULL WHERE objective IS NOT NULL AND ended_at IS NOT NULL AND ended_at<=?1",[time-RETENTION]).map_err(db)?;
    if conn.total_changes() != before {
        touch(conn)?;
    }
    Ok(())
}
pub(super) fn binding(conn: &Connection, grant_id: &str) -> Result<Option<String>, String> {
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='executor_plans')",[],|r|r.get(0)).map_err(db)?;
    if !exists {
        return Ok(None);
    }
    conn.query_row(
        "SELECT goal_id FROM executor_plans WHERE grant_id=?1",
        [grant_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(db)
}
pub(super) fn guard_unitary_request(conn: &Connection, request_id: &str) -> Result<(), String> {
    let reserved: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM executor_attempts WHERE request_id=?1)",
            [request_id],
            |r| r.get(0),
        )
        .map_err(db)?;
    if reserved {
        Err("Identificador reservado a uma tentativa do executor.".into())
    } else {
        Ok(())
    }
}
pub(super) fn guard_unitary(conn: &Connection, grant_id: &str) -> Result<(), String> {
    let bound: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM executor_plans WHERE grant_id=?1)",
            [grant_id],
            |r| r.get(0),
        )
        .map_err(db)?;
    if bound {
        Err("Concessão vinculada a um plano. Use os controles do executor.".into())
    } else {
        Ok(())
    }
}
fn goal(conn: &Connection, id: &str) -> Result<Goal, String> {
    let mut g=conn.query_row("SELECT id,objective,owner,status,plan_revision,expected_revision,consumed,budget,reason FROM executor_goals WHERE id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?,r.get::<_,i64>(7)?,r.get::<_,Option<String>>(8)?))).optional().map_err(db)?.ok_or("Objetivo inexistente.")?;
    let (body, grant_id): (Option<String>, String) = conn
        .query_row(
            "SELECT body,grant_id FROM executor_plans WHERE goal_id=?1 AND revision=?2",
            params![id, g.4],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db)?;
    let states = conn
        .prepare(
            "SELECT step_id,status,receipt_id FROM executor_steps WHERE goal_id=?1 ORDER BY rowid",
        )
        .map_err(db)?
        .query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(db)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db)?;
    let plan: Option<Plan> = body.map(|s| decode(&s)).transpose()?;
    let tasks = TaskStore::read(conn)?;
    let steps = states
        .into_iter()
        .map(|(id, status, key)| {
            let receipt = key
                .map(|k| {
                    conn.query_row(
                        &(RECEIPTS.to_owned() + " WHERE request_id=?1"),
                        [k],
                        receipt_row,
                    )
                    .map_err(db)
                })
                .transpose()?;
            let target = plan
                .as_ref()
                .and_then(|p| p.steps.iter().find(|s| s.id == id))
                .map(|s| s.target_id);
            let current_task_state = target
                .map_or("unavailable", |id| {
                    tasks
                        .tasks
                        .iter()
                        .find(|t| t.id == id)
                        .map_or(
                            "missing",
                            |t| if t.completed { "completed" } else { "pending" },
                        )
                })
                .to_string();
            Ok(StepState {
                id,
                status,
                receipt,
                current_task_state,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let attempts=conn.prepare("SELECT request_id,plan_revision,step_id,status,created_at FROM executor_attempts WHERE goal_id=?1 ORDER BY rowid").map_err(db)?.query_map([id],|r|Ok(AttemptRecord{request_id:r.get(0)?,plan_revision:r.get(1)?,step_id:r.get(2)?,status:r.get(3)?,created_at:r.get(4)?})).map_err(db)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db)?;
    Ok(Goal {
        id: g.0,
        objective: g.1.take(),
        owner: g.2,
        status: g.3,
        plan_revision: g.4,
        expected_revision: g.5,
        consumed: g.6,
        budget: g.7,
        reason: g.8,
        plan,
        grant: grant(conn, &grant_id)?,
        steps,
        attempts,
    })
}
fn validate(p: &Proposal) -> Result<(), String> {
    if p.objective.trim().is_empty()
        || p.objective.trim().chars().count() > 500
        || p.steps.is_empty()
        || p.steps.len() > 20
        || !(1..=20).contains(&p.max_operations.unwrap_or(20))
        || !(1..=1800).contains(&p.duration_seconds.unwrap_or(1800))
    {
        return Err(
            "Informe objetivo, 1–20 etapas, orçamento até 20 e prazo até 30 minutos.".into(),
        );
    }
    let mut seen = std::collections::HashSet::new();
    let mut targets = std::collections::HashSet::new();
    for s in &p.steps {
        identifier(&s.id)?;
        let deps: std::collections::HashSet<_> = s.depends_on.iter().collect();
        if s.target_id <= 0
            || seen.contains(&s.id)
            || !targets.insert(s.target_id)
            || s.depends_on.len() > 20
            || deps.len() != s.depends_on.len()
            || s.depends_on.iter().any(|d| !seen.contains(d))
        {
            return Err("IDs e alvos devem ser distintos; dependências devem existir antes da etapa, sem ciclos.".into());
        }
        seen.insert(s.id.clone());
    }
    Ok(())
}
impl DelegationRuntime {
    fn executor_prepare(
        &self,
        store: &TaskStore,
        window: &str,
        p: Proposal,
        time: i64,
    ) -> Result<Goal, String> {
        self.executor_prepare_checked(store, window, p, time, None)
    }
    pub(crate) fn executor_prepare_conversation(&self, store: &TaskStore, window: &str,
        proposal: Proposal, expected_revision: i64) -> Result<Goal, String> {
        self.executor_prepare_checked(store, window, proposal, LIVE, Some(expected_revision))
    }
    fn executor_prepare_checked(&self, store: &TaskStore, window: &str, p: Proposal,
        time: i64, expected_revision: Option<i64>) -> Result<Goal, String> {
        owner(window)?;
        validate(&p)?;
        self.transaction(store,time,|conn,time|{
            if expected_revision.is_some_and(|r| TaskStore::read(conn).map(|s| s.revision != r).unwrap_or(true)) {
                return Err("As tarefas mudaram. Faça um novo pedido para preparar o plano.".into());
            }
            let id=fresh(conn)?;
            let ids:Vec<_>=p.steps.iter().map(|s|s.target_id).collect();
            let grant=self.prepare_on(conn,window,p.objective.trim(),&ids,p.max_operations.unwrap_or(20),p.duration_seconds.unwrap_or(1800),time)?;
            let scope=grant.scope.as_ref().ok_or("Escopo indisponível.")?;
            conn.execute("INSERT INTO executor_goals(id,objective,owner,epoch,status,plan_revision,expected_revision,budget,created_at) VALUES(?1,?2,?3,?4,'draft',1,?5,?6,?7)",params![id,p.objective.trim(),window,self.epoch,scope.expected_revision,grant.max_operations,time]).map_err(db)?;
            conn.execute("INSERT INTO executor_plans VALUES(?1,1,?2,?3,?4)",params![id,json(&Plan{steps:p.steps.clone(),targets:scope.targets.clone(),omitted_steps:Vec::new()})?,grant.id,time]).map_err(db)?;
            for step in p.steps {conn.execute("INSERT INTO executor_steps VALUES(?1,?2,'pending',NULL)",params![id,step.id]).map_err(db)?;}
            touch(conn)?; goal(conn,&id)
        })
    }
    #[cfg(test)]
    fn executor_review(
        &self,
        store: &TaskStore,
        window: &str,
        id: &str,
        time: i64,
    ) -> Result<Goal, String> {
        self.executor_review_omitting(store, window, id, &[], time)
    }
    fn executor_review_omitting(
        &self,
        store: &TaskStore,
        window: &str,
        id: &str,
        omitted: &[String],
        time: i64,
    ) -> Result<Goal, String> {
        owner(window)?;
        identifier(id)?;
        if omitted.len() > 20 {
            return Err("Até 20 etapas podem ser retiradas na revisão.".into());
        }
        let unique: std::collections::HashSet<_> = omitted.iter().collect();
        if unique.len() != omitted.len() {
            return Err("Etapas repetidas na revisão.".into());
        }
        self.transaction(store,time,|conn,time|{
            let g=goal(conn,id)?;
            if g.owner!=window || !matches!(g.status.as_str(),"draft"|"interrupted"|"blocked") {return Err("Revise na origem um objetivo não iniciado, interrompido ou bloqueado.".into());}
            let mut plan=g.plan.ok_or("Plano indisponível após retenção.")?;
            let snapshot=TaskStore::read(conn)?;
            for id in omitted {
                let step=plan.steps.iter().find(|s|&s.id==id).ok_or("Etapa retirada não pertence ao plano atual.")?;
                if !g.steps.iter().any(|s|s.id==*id && s.status=="pending") || snapshot.tasks.iter().any(|t|t.id==step.target_id && !t.completed) {
                    return Err("Somente etapas pendentes com tarefa ausente ou concluída por outro caminho podem ser retiradas explicitamente.".into());
                }
            }
            let pending:Vec<_>=g.steps.iter().filter(|s|s.status=="pending" && !omitted.contains(&s.id)).map(|s|s.id.clone()).collect();
            if pending.is_empty() || g.consumed>=g.budget {return Err("Sem etapas executáveis ou saldo restante. Confira o resultado e cancele o objetivo se necessário.".into());}
            let ids:Vec<_>=plan.steps.iter().filter(|s|pending.contains(&s.id)).map(|s|s.target_id).collect();
            conn.execute("UPDATE delegation_grants SET status='revoked',ended_at=?1 WHERE id=?2 AND status IN ('draft','active')",params![time,g.grant.id]).map_err(db)?;
            let new=self.prepare_on(conn,window,g.objective.as_deref().ok_or("Objetivo indisponível.")?,&ids,g.budget-g.consumed,g.grant.scope.as_ref().map_or(1800,|s|s.duration_seconds),time)?;
            let scope=new.scope.as_ref().ok_or("Escopo indisponível.")?;
            for target in &scope.targets {if let Some(t)=plan.targets.iter_mut().find(|t|t.id==target.id){*t=target.clone();}}
            for step in &mut plan.steps {step.depends_on.retain(|d|!omitted.contains(d));}
            plan.steps.retain(|s|!omitted.contains(&s.id));
            plan.omitted_steps.extend_from_slice(omitted);
            for step in omitted {conn.execute("UPDATE executor_steps SET status='omitted' WHERE goal_id=?1 AND step_id=?2",params![id,step]).map_err(db)?;}
            let revision=g.plan_revision+1;
            conn.execute("INSERT INTO executor_plans VALUES(?1,?2,?3,?4,?5)",params![id,revision,json(&plan)?,new.id,time]).map_err(db)?;
            conn.execute("UPDATE executor_goals SET epoch=?1,status='draft',plan_revision=?2,expected_revision=?3,reason=NULL,ended_at=NULL WHERE id=?4",params![self.epoch,revision,scope.expected_revision,id]).map_err(db)?;
            touch(conn)?;goal(conn,id)
        })
    }
    fn executor_consent(
        &self,
        store: &TaskStore,
        window: &str,
        plan_id: &str,
        time: i64,
    ) -> Result<Goal, String> {
        owner(window)?;
        identifier(plan_id)?;
        self.transaction(store,time,|conn,time|{
            let id:String=conn.query_row("SELECT p.goal_id FROM executor_plans p JOIN executor_goals g ON g.id=p.goal_id AND g.plan_revision=p.revision WHERE p.grant_id=?1",[plan_id],|r|r.get(0)).optional().map_err(db)?.ok_or("Plano substituído ou inexistente.")?;
            let g=goal(conn,&id)?;
            if g.owner!=window {return Err("Confirme na janela de origem.".into());}
            if matches!(g.status.as_str(),"ready"|"running"|"completed") {return Ok(g);}
            if g.status!="draft" {return Err("Revise o restante antes de conceder.".into());}
            let granted=self.consent_on(conn,window,&g.grant.id,time)?;
            if granted.status!="active" {return Err("Rascunho encerrado; revise o restante.".into());}
            conn.execute("UPDATE executor_goals SET status='ready' WHERE id=?1",[&id]).map_err(|_|"Outro objetivo já está autorizado ou em execução.".to_string())?;
            touch(conn)?; goal(conn,&id)
        })
    }
    fn executor_start(
        &self,
        store: &TaskStore,
        window: &str,
        plan_id: &str,
        time: i64,
    ) -> Result<bool, String> {
        owner(window)?;
        identifier(plan_id)?;
        self.transaction(store,time,|conn,_|{
            let id:String=conn.query_row("SELECT p.goal_id FROM executor_plans p JOIN executor_goals g ON g.id=p.goal_id AND g.plan_revision=p.revision WHERE p.grant_id=?1",[plan_id],|r|r.get(0)).optional().map_err(db)?.ok_or("Plano substituído ou inexistente.")?;
            let g=goal(conn,&id)?;
            if g.owner!=window {return Err("Inicie na janela de origem.".into());}
            if g.status=="running" {return Ok(false);}
            if g.status!="ready" {return Err("Objetivo sem consentimento vigente.".into());}
            conn.execute("UPDATE executor_goals SET status='running' WHERE id=?1",[&id]).map_err(db)?;
            touch(conn)?; Ok(true)
        })
    }
    fn stop_on(&self, conn: &Connection, g: &Goal, reason: &str, time: i64) -> Result<(), String> {
        conn.execute("UPDATE delegation_grants SET status=?1,ended_at=?2 WHERE id=?3 AND status IN ('draft','active')",params![if reason=="blocked" {"revoked"} else {reason},time,g.grant.id]).map_err(db)?;
        conn.execute("UPDATE executor_goals SET status=?1,ended_at=?2,reason='Execução interrompida. Efeitos confirmados preservados; sem rollback automático.' WHERE id=?3",params![reason,time,g.id]).map_err(db)?;
        conn.execute("UPDATE executor_attempts SET status='not_committed' WHERE goal_id=?1 AND status='admitted' AND NOT EXISTS(SELECT 1 FROM delegation_receipts r WHERE r.request_id=executor_attempts.request_id AND r.grant_id=executor_attempts.grant_id AND r.target_id=executor_attempts.target_id AND r.before_revision=executor_attempts.expected_revision AND r.owner=(SELECT owner FROM executor_goals WHERE id=executor_attempts.goal_id))",[&g.id]).map_err(db)?;
        conn.execute(
            "UPDATE executor_steps SET status='pending' WHERE goal_id=?1 AND status='admitted'",
            [&g.id],
        )
        .map_err(db)?;
        touch(conn)
    }
    fn executor_end(
        &self,
        store: &TaskStore,
        window: &str,
        id: &str,
        reason: &str,
        time: i64,
    ) -> Result<Goal, String> {
        owner(window)?;
        identifier(id)?;
        if !matches!(reason, "cancelled" | "revoked" | "blocked") {
            return Err("Controle inválido.".into());
        }
        self.transaction(store, time, |conn, time| {
            let g = goal(conn, id)?;
            if g.status == reason
                || matches!(g.status.as_str(), "completed" | "cancelled" | "revoked")
            {
                return Ok(g);
            }
            self.stop_on(conn, &g, reason, time)?;
            goal(conn, id)
        })
    }
    fn executor_worker_finished(
        &self,
        store: &TaskStore,
        id: &str,
        plan_id: &str,
        time: i64,
    ) -> Result<(), String> {
        self.transaction(store, time, |conn, time| {
            let g = goal(conn, id)?;
            if g.status == "running" && g.grant.id == plan_id {
                self.stop_on(conn, &g, "blocked", time)?;
            }
            Ok(())
        })
    }
    fn executor_history(
        &self,
        store: &TaskStore,
        window: &str,
        time: i64,
    ) -> Result<Snapshot, String> {
        owner(window)?;
        self.transaction(store,time,|conn,_|{
            let ids=conn.prepare("SELECT id FROM executor_goals WHERE ended_at IS NULL OR id IN (SELECT id FROM executor_goals WHERE ended_at IS NOT NULL ORDER BY ended_at DESC,id DESC LIMIT 100) ORDER BY created_at DESC,id DESC").map_err(db)?.query_map([],|r|r.get::<_,String>(0)).map_err(db)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db)?;
            Ok(Snapshot{revision:conn.query_row("SELECT revision FROM executor_meta WHERE id=1",[],|r|r.get(0)).map_err(db)?,goals:ids.iter().map(|id|goal(conn,id)).collect::<Result<_,_>>()?})
        })
    }
    #[cfg(test)]
    fn executor_admit(
        &self,
        store: &TaskStore,
        id: &str,
        time: i64,
    ) -> Result<Option<Attempt>, String> {
        self.executor_admit_bound(store, id, None, time)
    }
    fn executor_admit_bound(
        &self,
        store: &TaskStore,
        id: &str,
        plan_id: Option<&str>,
        time: i64,
    ) -> Result<Option<Attempt>, String> {
        self.transaction(store,time,|conn,time|{
            let g=goal(conn,id)?;
            if g.status!="running" || plan_id.is_some_and(|p|p!=g.grant.id) {return Ok(None);}
            let plan=g.plan.ok_or("Plano indisponível.")?;
            if g.steps.iter().any(|s|s.status=="admitted") {return Ok(None);}
            let next=plan.steps.iter().find(|s|g.steps.iter().any(|t|t.id==s.id && t.status=="pending"));
            let Some(step)=next else {return Ok(None)};
            let snapshot=TaskStore::read(conn)?;
            let reason=if snapshot.revision!=g.expected_revision {Some("Revisão externa detectada. Nenhuma continuação automática.")}
                else if !snapshot.tasks.iter().any(|t|t.id==step.target_id && !t.completed) {Some("Tarefa concluída por outro caminho ou ausente; não é sucesso do executor.")}
                else if step.depends_on.iter().any(|d|!g.steps.iter().any(|s|&s.id==d && s.status=="succeeded")) {Some("Dependência não confirmada pelo executor.")}
                else if g.consumed>=g.budget {Some("Orçamento do objetivo esgotado.")} else {None};
            if let Some(reason)=reason {
                conn.execute("UPDATE executor_goals SET status='blocked',reason=?1,ended_at=?3 WHERE id=?2",params![reason,id,time]).map_err(db)?;
                conn.execute("UPDATE delegation_grants SET status='revoked',ended_at=?1 WHERE id=?2 AND status='active'",params![time,g.grant.id]).map_err(db)?;
                touch(conn)?;return Ok(None);
            }
            let a=Attempt{key:fresh(conn)?,goal:id.into(),plan:g.plan_revision,step:step.id.clone(),execution:Execution{grant_id:g.grant.id,request_id:String::new(),target_id:step.target_id,expected_revision:g.expected_revision}};
            let a=Attempt{execution:Execution{request_id:a.key.clone(),..a.execution},..a};
            conn.execute("INSERT INTO executor_attempts VALUES(?1,?2,?3,?4,?5,?6,?7,'admitted',?8)",params![a.key,id,a.plan,a.step,a.execution.grant_id,a.execution.target_id,a.execution.expected_revision,time]).map_err(db)?;
            conn.execute("UPDATE executor_steps SET status='admitted' WHERE goal_id=?1 AND step_id=?2",params![id,a.step]).map_err(db)?;
            touch(conn)?;Ok(Some(a))
        })
    }
    fn executor_commit(
        &self,
        store: &TaskStore,
        a: &Attempt,
        time: i64,
        boundary: impl Fn(u8) -> Result<(), String>,
    ) -> Result<Receipt, String> {
        self.transaction(store,time,|conn,time|{
            let g=goal(conn,&a.goal)?;
            let tuple:(i64,String,String,i64,i64,String)=conn.query_row("SELECT plan_revision,step_id,grant_id,target_id,expected_revision,status FROM executor_attempts WHERE request_id=?1 AND goal_id=?2",params![a.key,a.goal],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(db)?;
            if tuple.0!=a.plan || tuple.1!=a.step || tuple.2!=a.execution.grant_id || tuple.3!=a.execution.target_id || tuple.4!=a.execution.expected_revision {return Err("Vínculo de tentativa inválido.".into());}
            if tuple.5=="succeeded" { return conn.query_row(&(RECEIPTS.to_owned()+" WHERE request_id=?1"),[&a.key],receipt_row).map_err(db); }
            if tuple.5!="admitted" || g.plan_revision!=a.plan || g.expected_revision!=a.execution.expected_revision || g.consumed>=g.budget {return Err("Tentativa encerrada ou plano alterado.".into());}
            let receipt=self.complete_in_transaction(conn,&g.owner,a.execution.clone(),time,&boundary,true)?;
            conn.execute("UPDATE executor_attempts SET status='succeeded' WHERE request_id=?1",[&a.key]).map_err(db)?;
            conn.execute("UPDATE executor_steps SET status='succeeded',receipt_id=?1 WHERE goal_id=?2 AND step_id=?3",params![a.key,a.goal,a.step]).map_err(db)?;
            conn.execute("UPDATE executor_goals SET consumed=consumed+1,expected_revision=?1 WHERE id=?2",params![receipt.revision,a.goal]).map_err(db)?;
            let remaining:i64=conn.query_row("SELECT count(*) FROM executor_steps WHERE goal_id=?1 AND status IN ('pending','admitted')",[&a.goal],|r|r.get(0)).map_err(db)?;
            if remaining==0 && g.status=="running" {
                conn.execute("UPDATE executor_goals SET status='completed',ended_at=?1,reason=NULL WHERE id=?2",params![time,a.goal]).map_err(db)?;
            }
            boundary(6)?;touch(conn)?;Ok(receipt)
        })
    }
    // Shared by the native worker and deterministic tests. Observer never grants authority.
    fn executor_run(
        &self,
        store: &TaskStore,
        window: &str,
        plan_id: &str,
        time: i64,
        acknowledge: impl FnOnce(Result<(), String>),
        observe: impl Fn(u8, Option<&Attempt>) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut id = None;
        let mut owns_worker = false;
        let mut acknowledge = Some(acknowledge);
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
                let history = self.executor_history(store, window, time)?;
                let goal = history
                    .goals
                    .iter()
                    .find(|g| g.grant.id == plan_id)
                    .ok_or("Plano inexistente.")?
                    .id
                    .clone();
                id = Some(goal.clone());
                let started = self.executor_start(store, window, plan_id, time)?;
                if started {
                    owns_worker = true;
                    observe(0, None)?;
                }
                if let Some(ack) = acknowledge.take() {
                    ack(Ok(()));
                }
                if !started {
                    return Ok(());
                }
                loop {
                    let Some(a) = self.executor_admit_bound(store, &goal, Some(plan_id), time)?
                    else {
                        break;
                    };
                    observe(1, Some(&a))?;
                    if self.executor_commit(store, &a, time, |_| Ok(())).is_err() {
                        self.executor_uncertain(store, &a, time)?;
                        break;
                    }
                    observe(2, Some(&a))?;
                }
                Ok(())
            }));
        let result = match outcome {
            Ok(r) => r,
            Err(_) => Err(
                "Worker interrompido inesperadamente. Confira o andamento e revise explicitamente."
                    .into(),
            ),
        };
        if let Some(ack) = acknowledge.take() {
            ack(result.clone());
        }
        // If storage is unavailable, the explicit stop control remains a safe recovery path.
        if owns_worker {
            if let Some(id) = id {
                self.executor_worker_finished(store, &id, plan_id, time)?;
            }
        }
        result
    }
    fn executor_uncertain(&self, store: &TaskStore, a: &Attempt, time: i64) -> Result<(), String> {
        self.transaction(store,time,|conn,time|{
            let committed:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM delegation_receipts WHERE request_id=?1 AND grant_id=?2 AND target_id=?3 AND before_revision=?4 AND owner=(SELECT owner FROM executor_goals WHERE id=?5))",params![a.key,a.execution.grant_id,a.execution.target_id,a.execution.expected_revision,a.goal],|r|r.get(0)).map_err(db)?;
            if !committed {
                conn.execute("UPDATE executor_attempts SET status='not_committed' WHERE request_id=?1 AND status='admitted'",[&a.key]).map_err(db)?;
                let g=goal(conn,&a.goal)?;
                // A late worker may not reset a new revision's running step or authority.
                if g.plan_revision==a.plan && g.grant.id==a.execution.grant_id && g.status=="running" {self.stop_on(conn,&g,"blocked",time)?;}
            }
            Ok(())
        })
    }
}

fn emit(app: &tauri::AppHandle, store: &TaskStore) {
    let _ = app.emit("executor-changed", ());
    let _ = app.emit("delegation-changed", ());
    if let Ok(s) = store.list() {
        let _ = app.emit("tasks-changed", s);
    }
}
#[tauri::command]
pub async fn executor_prepare(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: State<'_, Arc<TaskStore>>,
    runtime: State<'_, Arc<DelegationRuntime>>,
    request: Proposal,
) -> Result<Goal, String> {
    let w = window.label().to_string();
    let s = store.inner().clone();
    let r = runtime.inner().clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || r.executor_prepare(&s, &w, request, LIVE))
            .await
            .map_err(|_| UNAVAILABLE.to_string())?;
    let _ = app.emit("executor-changed", ());
    result
}
#[tauri::command]
pub async fn executor_review(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: State<'_, Arc<TaskStore>>,
    runtime: State<'_, Arc<DelegationRuntime>>,
    goal_id: String,
    omit_step_ids: Option<Vec<String>>,
) -> Result<Goal, String> {
    let w = window.label().to_string();
    let s = store.inner().clone();
    let r = runtime.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        r.executor_review_omitting(&s, &w, &goal_id, &omit_step_ids.unwrap_or_default(), LIVE)
    })
    .await
    .map_err(|_| UNAVAILABLE.to_string())?;
    let _ = app.emit("executor-changed", ());
    result
}
#[tauri::command]
pub async fn executor_consent(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: State<'_, Arc<TaskStore>>,
    runtime: State<'_, Arc<DelegationRuntime>>,
    plan_id: String,
) -> Result<Goal, String> {
    let w = window.label().to_string();
    let s = store.inner().clone();
    let r = runtime.inner().clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || r.executor_consent(&s, &w, &plan_id, LIVE))
            .await
            .map_err(|_| UNAVAILABLE.to_string())?;
    let _ = app.emit("executor-changed", ());
    result
}
#[tauri::command]
pub async fn executor_end(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: State<'_, Arc<TaskStore>>,
    runtime: State<'_, Arc<DelegationRuntime>>,
    goal_id: String,
    reason: String,
) -> Result<Goal, String> {
    let w = window.label().to_string();
    let s = store.inner().clone();
    let r = runtime.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        r.executor_end(&s, &w, &goal_id, &reason, LIVE)
    })
    .await
    .map_err(|_| UNAVAILABLE.to_string())?;
    let _ = app.emit("executor-changed", ());
    let _ = app.emit("delegation-changed", ());
    result
}
#[tauri::command]
pub async fn executor_history(
    window: tauri::WebviewWindow,
    store: State<'_, Arc<TaskStore>>,
    runtime: State<'_, Arc<DelegationRuntime>>,
) -> Result<Snapshot, String> {
    let w = window.label().to_string();
    let s = store.inner().clone();
    let r = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || r.executor_history(&s, &w, LIVE))
        .await
        .map_err(|_| UNAVAILABLE.to_string())?
}
#[tauri::command]
pub async fn executor_start(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: State<'_, Arc<TaskStore>>,
    runtime: State<'_, Arc<DelegationRuntime>>,
    plan_id: String,
) -> Result<(), String> {
    let w = window.label().to_string();
    let s = store.inner().clone();
    let r = runtime.inner().clone();
    // State transition and worker execution belong to ONE blocking job. Reloading the
    // WebView or losing the acknowledgment cannot cancel or recreate that job.
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = r.executor_run(
            &s,
            &w,
            &plan_id,
            LIVE,
            |result| {
                let _ = tx.send(result);
            },
            |_, _| {
                emit(&app, &s);
                Ok(())
            },
        );
        emit(&app, &s);
    });
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|_| UNAVAILABLE.to_string())?)
        .await
        .map_err(|_| UNAVAILABLE.to_string())?
}

#[cfg(test)]
#[path = "executor-tests.rs"]
mod tests;
