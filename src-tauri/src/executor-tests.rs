use super::*;
use crate::tasks::TaskInput;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
const START: i64 = 1_800_000_000;
struct Fixture {
    store: TaskStore,
    path: std::path::PathBuf,
    r: DelegationRuntime,
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "jarvis-m2-2-unit-{}-{}.sqlite3",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let f = Self {
            store: TaskStore::new(path.clone()),
            path,
            r: DelegationRuntime::new().unwrap(),
        };
        for name in [
            "Primeira sintética",
            "Segunda sintética",
            "Externa sintética",
        ] {
            f.store.save(None, input(name)).unwrap();
        }
        f
    }
    fn proposal(&self) -> Proposal {
        Proposal {
            objective: "Sequência sintética".into(),
            steps: vec![
                Step {
                    id: "first".into(),
                    operation: Operation::CompleteTask,
                    target_id: 1,
                    depends_on: vec![],
                },
                Step {
                    id: "second".into(),
                    operation: Operation::CompleteTask,
                    target_id: 2,
                    depends_on: vec!["first".into()],
                },
            ],
            max_operations: None,
            duration_seconds: None,
        }
    }
    fn draft(&self) -> Goal {
        self.r
            .executor_prepare(&self.store, "dashboard", self.proposal(), START)
            .unwrap()
    }
    fn running(&self) -> Goal {
        let g = self.draft();
        self.r
            .executor_consent(&self.store, "dashboard", &g.grant.id, START)
            .unwrap();
        assert!(self
            .r
            .executor_start(&self.store, "dashboard", &g.grant.id, START)
            .unwrap());
        g
    }
    fn state(&self, id: &str) -> Goal {
        self.r
            .executor_history(&self.store, "dashboard", START)
            .unwrap()
            .goals
            .into_iter()
            .find(|g| g.id == id)
            .unwrap()
    }
    fn admit(&self, id: &str) -> Attempt {
        self.r
            .executor_admit(&self.store, id, START)
            .unwrap()
            .unwrap()
    }
}
fn input(title: &str) -> TaskInput {
    TaskInput {
        title: title.into(),
        description: String::new(),
        project: String::new(),
        priority: "normal".into(),
        due_date: None,
        due_time: None,
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
#[test]
fn checkpoint_a_two_real_effects_dependencies_revisions_budget_receipts() {
    let f = Fixture::new();
    let g = f.running();
    assert_eq!(g.budget, 20);
    assert_eq!(g.grant.scope.as_ref().unwrap().duration_seconds, 1800);
    let a = f.admit(&g.id);
    assert_eq!(a.step, "first");
    assert_eq!(f.store.list().unwrap().revision, 3);
    assert!(f
        .r
        .executor_admit(&f.store, &g.id, START)
        .unwrap()
        .is_none());
    let r1 =
        f.r.executor_commit(&f.store, &a, START, |_| Ok(()))
            .unwrap();
    let b = f.admit(&g.id);
    assert_eq!(b.step, "second");
    assert_eq!(b.execution.expected_revision, r1.revision);
    let r2 =
        f.r.executor_commit(&f.store, &b, START, |_| Ok(()))
            .unwrap();
    let done = f.state(&g.id);
    assert_eq!(done.status, "completed");
    assert_eq!(done.consumed, 2);
    assert_eq!(done.expected_revision, 5);
    assert_eq!(done.grant.used, 2);
    assert_eq!(done.steps[0].receipt.as_ref().unwrap(), &r1);
    assert_eq!(done.steps[1].receipt.as_ref().unwrap(), &r2);
    assert!(f.store.list().unwrap().tasks[..2]
        .iter()
        .all(|t| t.completed));
}
#[test]
fn adversarial_shape_cycles_targets_and_operation_rejected() {
    let f = Fixture::new();
    for variant in 0..7 {
        let mut p = f.proposal();
        match variant {
            0 => p.steps[0].depends_on.push("second".into()),
            1 => p.steps[1].depends_on.push("missing".into()),
            2 => p.steps[1].target_id = 1,
            3 => p.steps[1].id = "first".into(),
            4 => p.max_operations = Some(21),
            5 => p.duration_seconds = Some(1801),
            _ => p.steps[0].target_id = 999,
        };
        assert!(f
            .r
            .executor_prepare(&f.store, "dashboard", p, START)
            .is_err());
    }
    let p = json(&f.proposal().steps)
        .unwrap()
        .replace("complete_task", "delete_task");
    assert!(serde_json::from_str::<Vec<Step>>(&p).is_err());
    assert!(serde_json::from_str::<Step>(
        r#"{"id":"a","operation":"complete_task","targetId":1,"dependsOn":[],"owner":"dashboard"}"#
    )
    .is_err());
    assert_eq!(f.store.list().unwrap().revision, 3);
}
#[test]
fn origin_consent_start_and_unitary_bypass_fail_closed() {
    let f = Fixture::new();
    let g = f.draft();
    assert!(f
        .r
        .executor_start(&f.store, "dashboard", &g.grant.id, START)
        .is_err());
    assert!(f
        .r
        .executor_consent(&f.store, "assistant", &g.grant.id, START)
        .is_err());
    assert!(f
        .r
        .consent(&f.store, "dashboard", &g.grant.id, START)
        .is_err());
    f.r.executor_consent(&f.store, "dashboard", &g.grant.id, START)
        .unwrap();
    assert!(f
        .r
        .executor_start(&f.store, "assistant", &g.grant.id, START)
        .is_err());
    for target in [1, 2, 3] {
        assert!(f
            .r
            .execute(
                &f.store,
                "dashboard",
                Execution {
                    grant_id: g.grant.id.clone(),
                    request_id: format!("bypass-{target}"),
                    target_id: target,
                    expected_revision: 3
                },
                START
            )
            .is_err());
    }
    assert_eq!(f.store.list().unwrap().revision, 3);
    assert_eq!(f.state(&g.id).consumed, 0);
}
#[test]
fn external_revision_never_silently_rebased() {
    let f = Fixture::new();
    let g = f.running();
    let a = f.admit(&g.id);
    f.r.executor_commit(&f.store, &a, START, |_| Ok(()))
        .unwrap();
    f.store.save(Some(3), input("Alteração externa")).unwrap();
    assert!(f
        .r
        .executor_admit(&f.store, &g.id, START)
        .unwrap()
        .is_none());
    let blocked = f.state(&g.id);
    assert_eq!(blocked.status, "blocked");
    assert_eq!(blocked.expected_revision, 4);
    assert_eq!(blocked.consumed, 1);
    assert!(!f.store.list().unwrap().tasks[1].completed);
    let reviewed =
        f.r.executor_review(&f.store, "dashboard", &g.id, START)
            .unwrap();
    assert_eq!(reviewed.plan_revision, 2);
    assert_eq!(reviewed.expected_revision, 5);
    assert_eq!(reviewed.consumed, 1);
    assert_eq!(reviewed.grant.max_operations, 19);
    assert!(f
        .r
        .executor_consent(&f.store, "dashboard", &g.grant.id, START)
        .is_err());
    assert!(f
        .r
        .executor_start(&f.store, "dashboard", &g.grant.id, START)
        .is_err());
}
#[test]
fn external_completion_is_never_executor_success() {
    let f = Fixture::new();
    let g = f.running();
    f.store.complete(1, true).unwrap();
    assert!(f
        .r
        .executor_admit(&f.store, &g.id, START)
        .unwrap()
        .is_none());
    let b = f.state(&g.id);
    assert_eq!(b.status, "blocked");
    assert_eq!(b.consumed, 0);
    assert!(b.steps.iter().all(|s| s.receipt.is_none()));
    assert!(f
        .r
        .executor_review(&f.store, "dashboard", &g.id, START)
        .is_err());
}
#[test]
fn checkpoint_b_all_atomic_boundaries_roll_back_step_and_effect() {
    for boundary in 0..=6 {
        let f = Fixture::new();
        let g = f.running();
        let a = f.admit(&g.id);
        assert!(f
            .r
            .executor_commit(&f.store, &a, START, |n| if n == boundary {
                Err("injected".into())
            } else {
                Ok(())
            })
            .is_err());
        let state = f.state(&g.id);
        assert_eq!(state.consumed, 0);
        assert_eq!(state.grant.used, 0);
        assert_eq!(state.steps[0].status, "admitted");
        assert_eq!(state.expected_revision, 3);
        assert_eq!(f.store.list().unwrap().revision, 3);
        assert!(state.steps[0].receipt.is_none());
        f.r.executor_uncertain(&f.store, &a, START).unwrap();
        assert_eq!(f.state(&g.id).status, "blocked");
        assert!(f
            .r
            .executor_admit(&f.store, &g.id, START)
            .unwrap()
            .is_none());
    }
}
#[test]
fn lost_response_replay_and_parameter_collision_do_not_repeat() {
    let f = Fixture::new();
    let g = f.running();
    let a = f.admit(&g.id);
    let receipt =
        f.r.executor_commit(&f.store, &a, START, |_| Ok(()))
            .unwrap();
    assert_eq!(
        f.r.executor_commit(&f.store, &a, START, |_| panic!("replayed effect"))
            .unwrap(),
        receipt
    );
    assert_eq!(f.store.list().unwrap().revision, 4);
    assert_eq!(f.state(&g.id).consumed, 1);
    let mut tampered = a.clone();
    tampered.execution.target_id = 2;
    assert!(f
        .r
        .executor_commit(&f.store, &tampered, START, |_| Ok(()))
        .is_err());
    // Existing exact receipt replay is still available through M2.1, never new effects.
    assert_eq!(
        f.r.execute(&f.store, "dashboard", a.execution.clone(), START)
            .unwrap(),
        receipt
    );
    let mut collision = a.execution;
    collision.target_id = 2;
    assert!(f
        .r
        .execute(&f.store, "dashboard", collision, START)
        .is_err());
}
#[test]
fn restart_after_admission_no_effect_and_explicit_new_grant_required() {
    let f = Fixture::new();
    let g = f.running();
    let a = f.admit(&g.id);
    let restarted = DelegationRuntime::new().unwrap();
    let s = restarted
        .executor_history(&f.store, "assistant", START + 1)
        .unwrap();
    let state = &s.goals[0];
    assert_eq!(state.status, "interrupted");
    assert_eq!(state.consumed, 0);
    assert_eq!(state.steps[0].status, "pending");
    assert_eq!(f.store.list().unwrap().revision, 3);
    assert!(restarted
        .executor_admit(&f.store, &g.id, START + 1)
        .unwrap()
        .is_none());
    assert!(restarted
        .executor_commit(&f.store, &a, START + 1, |_| Ok(()))
        .is_err());
    assert!(restarted
        .executor_start(&f.store, "dashboard", &g.grant.id, START + 1)
        .is_err());
    let reviewed = restarted
        .executor_review(&f.store, "dashboard", &g.id, START + 1)
        .unwrap();
    assert_eq!(reviewed.status, "draft");
    assert!(restarted
        .executor_start(&f.store, "dashboard", &reviewed.grant.id, START + 1)
        .is_err());
    restarted
        .executor_consent(&f.store, "dashboard", &reviewed.grant.id, START + 1)
        .unwrap();
    assert!(restarted
        .executor_start(&f.store, "dashboard", &reviewed.grant.id, START + 1)
        .unwrap());
}
#[test]
fn restart_after_commit_preserves_total_and_only_remaining_executes() {
    let f = Fixture::new();
    let g = f.running();
    let a = f.admit(&g.id);
    let receipt =
        f.r.executor_commit(&f.store, &a, START, |_| Ok(()))
            .unwrap();
    let r = DelegationRuntime::new().unwrap();
    let s = r
        .executor_history(&f.store, "dashboard", START + 1)
        .unwrap();
    assert_eq!(s.goals[0].consumed, 1);
    assert_eq!(s.goals[0].steps[0].receipt.as_ref().unwrap(), &receipt);
    let new = r
        .executor_review(&f.store, "dashboard", &g.id, START + 1)
        .unwrap();
    assert_eq!(new.grant.max_operations, 19);
    r.executor_consent(&f.store, "dashboard", &new.grant.id, START + 1)
        .unwrap();
    r.executor_start(&f.store, "dashboard", &new.grant.id, START + 1)
        .unwrap();
    let b = r
        .executor_admit(&f.store, &g.id, START + 1)
        .unwrap()
        .unwrap();
    assert_eq!(b.step, "second");
    r.executor_commit(&f.store, &b, START + 1, |_| Ok(()))
        .unwrap();
    assert_eq!(f.store.list().unwrap().revision, 5);
    assert_eq!(
        r.executor_history(&f.store, "dashboard", START + 1)
            .unwrap()
            .goals[0]
            .consumed,
        2
    );
}
#[test]
fn cancellation_and_revocation_serialize_with_admission() {
    for reason in ["cancelled", "revoked"] {
        let f = Fixture::new();
        let g = f.running();
        let a = f.admit(&g.id);
        f.r.executor_end(&f.store, "assistant", &g.id, reason, START)
            .unwrap();
        assert!(f
            .r
            .executor_commit(&f.store, &a, START, |_| Ok(()))
            .is_err());
        assert!(f
            .r
            .executor_admit(&f.store, &g.id, START)
            .unwrap()
            .is_none());
        assert_eq!(f.state(&g.id).status, reason);
        assert_eq!(f.store.list().unwrap().revision, 3);
    }
}
#[test]
fn one_active_objective_and_concurrent_admission_commit() {
    let f = Fixture::new();
    let g = f.running();
    let other = f.draft();
    assert!(f
        .r
        .executor_consent(&f.store, "dashboard", &other.grant.id, START)
        .is_err());
    let (a, b) = std::thread::scope(|scope| {
        let a = scope.spawn(|| {
            f.r.executor_admit(&TaskStore::new(f.path.clone()), &g.id, START)
                .unwrap()
        });
        let b = scope.spawn(|| {
            f.r.executor_admit(&TaskStore::new(f.path.clone()), &g.id, START)
                .unwrap()
        });
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_ne!(a.is_some(), b.is_some());
    let a = a.or(b).unwrap();
    let (one, two) = std::thread::scope(|scope| {
        let one = scope.spawn(|| {
            f.r.executor_commit(&TaskStore::new(f.path.clone()), &a, START, |_| Ok(()))
                .unwrap()
        });
        let two = scope.spawn(|| {
            f.r.executor_commit(&TaskStore::new(f.path.clone()), &a, START, |_| Ok(()))
                .unwrap()
        });
        (one.join().unwrap(), two.join().unwrap())
    });
    assert_eq!(one, two);
    assert_eq!(f.store.list().unwrap().revision, 4);
    assert_eq!(f.state(&g.id).consumed, 1);
}
#[test]
fn budget_expiration_and_no_implicit_renewal() {
    let f = Fixture::new();
    let mut p = f.proposal();
    p.max_operations = Some(1);
    let g =
        f.r.executor_prepare(&f.store, "dashboard", p, START)
            .unwrap();
    let c =
        f.r.executor_consent(&f.store, "dashboard", &g.grant.id, START)
            .unwrap();
    assert_eq!(
        f.r.executor_consent(&f.store, "dashboard", &g.grant.id, START + 1)
            .unwrap()
            .grant
            .expires_at,
        c.grant.expires_at
    );
    f.r.executor_start(&f.store, "dashboard", &g.grant.id, START)
        .unwrap();
    let a = f.admit(&g.id);
    f.r.executor_commit(&f.store, &a, START, |_| Ok(()))
        .unwrap();
    assert!(f
        .r
        .executor_admit(&f.store, &g.id, START)
        .unwrap()
        .is_none());
    assert_eq!(f.state(&g.id).consumed, 1);
    assert!(f
        .r
        .executor_review(&f.store, "dashboard", &g.id, START)
        .is_err());
    let f = Fixture::new();
    let g = f.running();
    let a = f.admit(&g.id);
    assert!(f
        .r
        .executor_commit(&f.store, &a, START + 1800, |_| Ok(()))
        .is_err());
    assert_eq!(f.store.list().unwrap().revision, 3);
    assert_eq!(
        f.r.executor_history(&f.store, "dashboard", START + 1800)
            .unwrap()
            .goals[0]
            .status,
        "blocked"
    );
}
#[test]
fn immutable_plan_and_retention_keep_receipt_tombstones() {
    let f = Fixture::new();
    let g = f.running();
    let a = f.admit(&g.id);
    let receipt =
        f.r.executor_commit(&f.store, &a, START, |_| Ok(()))
            .unwrap();
    f.r.executor_end(&f.store, "assistant", &g.id, "cancelled", START)
        .unwrap();
    let conn = f.store.connect().unwrap();
    assert!(conn
        .execute(
            "UPDATE executor_plans SET body='{}' WHERE goal_id=?1",
            [&g.id]
        )
        .is_err());
    drop(conn);
    let history =
        f.r.executor_history(&f.store, "dashboard", START + RETENTION + 1)
            .unwrap();
    let retained = &history.goals[0];
    assert!(retained.objective.is_none());
    assert!(retained.plan.is_none());
    assert!(retained.grant.scope.is_none());
    assert_eq!(retained.steps[0].receipt.as_ref().unwrap(), &receipt);
    assert_eq!(
        f.r.execute(&f.store, "dashboard", a.execution, START + RETENTION + 1)
            .unwrap(),
        receipt
    );
    assert_eq!(f.store.list().unwrap().revision, 4);
}

#[test]
fn obsolete_and_expired_drafts_can_be_reviewed_without_new_authority() {
    let f = Fixture::new();
    let g = f.draft();
    f.store.save(Some(3), input("Edição externa")).unwrap();
    assert!(f
        .r
        .executor_consent(&f.store, "dashboard", &g.grant.id, START)
        .is_err());
    let next =
        f.r.executor_review(&f.store, "dashboard", &g.id, START)
            .unwrap();
    assert_eq!(next.plan_revision, 2);
    assert_eq!(next.status, "draft");
    assert_eq!(next.expected_revision, 4);
    assert!(f
        .r
        .executor_start(&f.store, "dashboard", &next.grant.id, START)
        .is_err());
    let f = Fixture::new();
    let g = f.draft();
    let h =
        f.r.executor_history(&f.store, "dashboard", START + 900)
            .unwrap();
    assert_eq!(h.goals[0].status, "blocked");
    let n =
        f.r.executor_review(&f.store, "dashboard", &g.id, START + 900)
            .unwrap();
    assert_eq!(n.status, "draft");
    assert!(n.grant.granted_at.is_none());
}
#[test]
fn blocked_goals_lose_details_after_retention_without_losing_attempts() {
    let f = Fixture::new();
    let g = f.running();
    let a = f.admit(&g.id);
    f.r.executor_commit(&f.store, &a, START, |_| Err("injected".into()))
        .unwrap_err();
    f.r.executor_uncertain(&f.store, &a, START).unwrap();
    let h =
        f.r.executor_history(&f.store, "dashboard", START + RETENTION + 1)
            .unwrap();
    assert!(h.goals[0].objective.is_none());
    assert!(h.goals[0].plan.is_none());
    assert_eq!(h.goals[0].attempts[0].status, "not_committed");
    assert_eq!(f.store.list().unwrap().revision, 3);
}
#[test]
fn explicit_stop_fences_admitted_and_late_worker_results_from_new_plan() {
    let f = Fixture::new();
    let g = f.running();
    let a = f.admit(&g.id);
    f.r.executor_end(&f.store, "assistant", &g.id, "blocked", START)
        .unwrap();
    let next =
        f.r.executor_review(&f.store, "dashboard", &g.id, START)
            .unwrap();
    f.r.executor_consent(&f.store, "dashboard", &next.grant.id, START)
        .unwrap();
    f.r.executor_start(&f.store, "dashboard", &next.grant.id, START)
        .unwrap();
    assert!(f
        .r
        .executor_admit_bound(&f.store, &g.id, Some(&g.grant.id), START)
        .unwrap()
        .is_none());
    let b =
        f.r.executor_admit_bound(&f.store, &g.id, Some(&next.grant.id), START)
            .unwrap()
            .unwrap();
    assert!(f
        .r
        .executor_commit(&f.store, &a, START, |_| Ok(()))
        .is_err());
    f.r.executor_uncertain(&f.store, &a, START).unwrap();
    f.r.executor_worker_finished(&f.store, &g.id, &g.grant.id, START)
        .unwrap();
    let state = f.state(&g.id);
    assert_eq!(state.status, "running");
    assert_eq!(state.steps[0].status, "admitted");
    f.r.executor_commit(&f.store, &b, START, |_| Ok(()))
        .unwrap();
    assert_eq!(f.state(&g.id).consumed, 1);
}
#[test]
fn worker_failure_blocks_and_can_be_explicitly_reviewed() {
    let f = Fixture::new();
    let g = f.running();
    let _a = f.admit(&g.id);
    f.r.executor_worker_finished(&f.store, &g.id, &g.grant.id, START)
        .unwrap();
    let state = f.state(&g.id);
    assert_eq!(state.status, "blocked");
    assert_eq!(state.steps[0].status, "pending");
    assert_eq!(state.attempts[0].status, "not_committed");
    assert!(f
        .r
        .executor_start(&f.store, "dashboard", &g.grant.id, START)
        .is_err());
    let next =
        f.r.executor_review(&f.store, "dashboard", &g.id, START)
            .unwrap();
    assert_eq!(next.consumed, 0);
    assert_eq!(next.status, "draft");
}
#[test]
fn external_completion_only_removed_by_explicit_new_revision_and_consent() {
    let f = Fixture::new();
    let g = f.running();
    f.store.complete(1, true).unwrap();
    assert!(f
        .r
        .executor_admit(&f.store, &g.id, START)
        .unwrap()
        .is_none());
    let state = f.state(&g.id);
    assert_eq!(state.steps[0].current_task_state, "completed");
    assert_eq!(state.steps[0].status, "pending");
    assert_eq!(state.consumed, 0);
    assert!(f
        .r
        .executor_review(&f.store, "dashboard", &g.id, START)
        .is_err());
    assert!(f
        .r
        .executor_review_omitting(&f.store, "dashboard", &g.id, &["second".into()], START)
        .is_err());
    assert!(f
        .r
        .executor_review_omitting(&f.store, "assistant", &g.id, &["first".into()], START)
        .is_err());
    let next =
        f.r.executor_review_omitting(&f.store, "dashboard", &g.id, &["first".into()], START)
            .unwrap();
    assert_eq!(next.plan.as_ref().unwrap().omitted_steps, vec!["first"]);
    assert!(next.plan.as_ref().unwrap().steps[0].depends_on.is_empty());
    assert_eq!(next.steps[0].status, "omitted");
    assert!(next.steps[0].receipt.is_none());
    assert_eq!(next.consumed, 0);
    assert!(f
        .r
        .executor_start(&f.store, "dashboard", &next.grant.id, START)
        .is_err());
    f.r.executor_consent(&f.store, "dashboard", &next.grant.id, START)
        .unwrap();
    f.r.executor_start(&f.store, "dashboard", &next.grant.id, START)
        .unwrap();
    let b = f.admit(&g.id);
    assert_eq!(b.step, "second");
    f.r.executor_commit(&f.store, &b, START, |_| Ok(()))
        .unwrap();
    let done = f.state(&g.id);
    assert_eq!(done.status, "completed");
    assert_eq!(done.consumed, 1);
    assert_eq!(done.steps[0].status, "omitted");
    assert!(done.steps[0].receipt.is_none());
}
#[test]
fn completion_and_control_race_have_one_sqlite_order() {
    for reason in ["cancelled", "revoked", "blocked"] {
        let f = Fixture::new();
        let g = f.running();
        let a = f.admit(&g.id);
        let barrier = std::sync::Barrier::new(2);
        let (effect, control) = std::thread::scope(|scope| {
            let effect = scope.spawn(|| {
                barrier.wait();
                f.r.executor_commit(&TaskStore::new(f.path.clone()), &a, START, |_| Ok(()))
            });
            let control = scope.spawn(|| {
                barrier.wait();
                f.r.executor_end(
                    &TaskStore::new(f.path.clone()),
                    "assistant",
                    &g.id,
                    reason,
                    START,
                )
            });
            (effect.join().unwrap(), control.join().unwrap())
        });
        assert!(control.is_ok());
        let state = f.state(&g.id);
        assert_eq!(state.status, reason);
        assert_eq!(state.consumed, if effect.is_ok() { 1 } else { 0 });
        assert_eq!(f.store.list().unwrap().revision, 3 + state.consumed);
        assert!(f
            .r
            .executor_admit(&f.store, &g.id, START)
            .unwrap()
            .is_none());
    }
}
#[test]
fn task_reopened_after_executor_success_remains_a_factual_receipt() {
    let f = Fixture::new();
    let g = f.running();
    let a = f.admit(&g.id);
    f.r.executor_commit(&f.store, &a, START, |_| Ok(()))
        .unwrap();
    f.store.complete(1, false).unwrap();
    assert!(f
        .r
        .executor_admit(&f.store, &g.id, START)
        .unwrap()
        .is_none());
    let state = f.state(&g.id);
    assert_eq!(state.steps[0].status, "succeeded");
    assert_eq!(state.steps[0].current_task_state, "pending");
    assert!(state.steps[0].receipt.is_some());
    assert_eq!(state.consumed, 1);
}

#[test]
fn first_late_read_and_repeated_restart_never_extend_retention() {
    for restart in [false, true] {
        let f = Fixture::new();
        let _g = f.draft();
        let r = DelegationRuntime::new().unwrap();
        let runtime = if restart { &r } else { &f.r };
        let h = runtime
            .executor_history(&f.store, "dashboard", START + 900 + RETENTION + 1)
            .unwrap();
        assert!(h.goals[0].plan.is_none());
        assert!(h.goals[0].objective.is_none());
    }
    let f = Fixture::new();
    let g = f.running();
    f.r.executor_end(&f.store, "assistant", &g.id, "blocked", START)
        .unwrap();
    for offset in [10, 20, RETENTION + 1] {
        let r = DelegationRuntime::new().unwrap();
        let h = r
            .executor_history(&f.store, "dashboard", START + offset)
            .unwrap();
        if offset > RETENTION {
            assert!(h.goals[0].plan.is_none());
            assert!(h.goals[0].objective.is_none());
        }
    }
}
#[test]
fn real_worker_panics_and_errors_reconcile_without_repeating_effects() {
    for panic in [false, true] {
        for after_commit in [false, true] {
            let f = Fixture::new();
            let g = f.draft();
            f.r.executor_consent(&f.store, "dashboard", &g.grant.id, START)
                .unwrap();
            let result = f.r.executor_run(
                &f.store,
                "dashboard",
                &g.grant.id,
                START,
                |r| assert!(r.is_ok()),
                |stage, _| {
                    if stage == if after_commit { 2 } else { 1 } {
                        if panic {
                            panic!("synthetic worker panic");
                        } else {
                            return Err("synthetic worker failure".into());
                        }
                    }
                    Ok(())
                },
            );
            assert!(result.is_err());
            let state = f.state(&g.id);
            assert_eq!(state.status, "blocked");
            assert_eq!(state.consumed, if after_commit { 1 } else { 0 });
            assert_eq!(f.store.list().unwrap().revision, 3 + state.consumed);
            assert_eq!(
                state.attempts[0].status,
                if after_commit {
                    "succeeded"
                } else {
                    "not_committed"
                }
            );
            assert!(f
                .r
                .executor_admit(&f.store, &g.id, START)
                .unwrap()
                .is_none());
        }
    }
}
#[test]
fn real_worker_duplicate_start_lost_ack_and_cross_window_cancel_are_serialized() {
    let f = Fixture::new();
    let g = f.draft();
    f.r.executor_consent(&f.store, "dashboard", &g.grant.id, START)
        .unwrap();
    let entered = std::sync::Barrier::new(2);
    let release = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let running = scope.spawn(|| {
            f.r.executor_run(
                &TaskStore::new(f.path.clone()),
                "dashboard",
                &g.grant.id,
                START,
                |_| { /* deliberately lost acknowledgment */ },
                |stage, _| {
                    if stage == 1 {
                        entered.wait();
                        release.wait();
                    }
                    Ok(())
                },
            )
        });
        entered.wait();
        // A duplicate start acknowledges without owning/finalizing the live worker.
        f.r.executor_run(
            &TaskStore::new(f.path.clone()),
            "dashboard",
            &g.grant.id,
            START,
            |r| assert!(r.is_ok()),
            |_, _| panic!("duplicate worker"),
        )
        .unwrap();
        assert_eq!(f.state(&g.id).status, "running");
        assert_eq!(f.state(&g.id).consumed, 0);
        f.r.executor_end(&f.store, "assistant", &g.id, "cancelled", START)
            .unwrap();
        release.wait();
        assert!(running.join().unwrap().is_ok());
    });
    assert_eq!(f.state(&g.id).status, "cancelled");
    assert_eq!(f.store.list().unwrap().revision, 3);
}
#[test]
fn real_worker_keeps_committed_result_when_response_receiver_disappears() {
    let f = Fixture::new();
    let g = f.draft();
    f.r.executor_consent(&f.store, "dashboard", &g.grant.id, START)
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    drop(rx);
    f.r.executor_run(
        &f.store,
        "dashboard",
        &g.grant.id,
        START,
        |result| {
            assert!(tx.send(result).is_err());
        },
        |_, _| Ok(()),
    )
    .unwrap();
    let state = f.state(&g.id);
    assert_eq!(state.status, "completed");
    assert_eq!(state.consumed, 2);
    assert_eq!(state.attempts.len(), 2);
    assert_eq!(f.store.list().unwrap().revision, 5);
}

#[test]
fn replay_of_stop_does_not_postpone_retention_or_change_canonical_revision() {
    let f = Fixture::new();
    let g = f.running();
    f.r.executor_end(&f.store, "assistant", &g.id, "blocked", START)
        .unwrap();
    let revision =
        f.r.executor_history(&f.store, "dashboard", START)
            .unwrap()
            .revision;
    f.r.executor_end(&f.store, "assistant", &g.id, "blocked", START + 100)
        .unwrap();
    assert_eq!(
        f.r.executor_history(&f.store, "dashboard", START + 100)
            .unwrap()
            .revision,
        revision
    );
    let ended: i64 = f
        .store
        .connect()
        .unwrap()
        .query_row(
            "SELECT ended_at FROM executor_goals WHERE id=?1",
            [&g.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ended, START);
    let h =
        f.r.executor_history(&f.store, "dashboard", START + RETENTION + 1)
            .unwrap();
    assert!(h.goals[0].objective.is_none());
}

#[test]
fn unitary_request_cannot_steal_a_durably_admitted_plan_key() {
    let f = Fixture::new();
    let legacy =
        f.r.prepare(
            &f.store,
            "assistant",
            Request {
                objective: "Legado sintético".into(),
                target_ids: vec![3],
                max_operations: None,
                duration_seconds: None,
            },
            START,
        )
        .unwrap();
    f.r.consent(&f.store, "assistant", &legacy.id, START)
        .unwrap();
    let g = f.running();
    let a = f.admit(&g.id);
    let collision = Execution {
        grant_id: legacy.id.clone(),
        request_id: a.key.clone(),
        target_id: 3,
        expected_revision: 3,
    };
    assert!(f
        .r
        .execute(&f.store, "assistant", collision, START)
        .is_err());
    assert_eq!(f.store.list().unwrap().revision, 3);
    assert_eq!(f.state(&g.id).steps[0].status, "admitted");
    f.r.executor_commit(&f.store, &a, START, |_| Ok(()))
        .unwrap();
    assert_eq!(f.state(&g.id).consumed, 1);
    assert_eq!(f.store.list().unwrap().revision, 4);
    let own = Execution {
        grant_id: legacy.id,
        request_id: "own-legacy-key".into(),
        target_id: 3,
        expected_revision: 4,
    };
    assert!(f.r.execute(&f.store, "assistant", own, START).is_ok());
}
#[test]
fn reconciliation_does_not_mistake_foreign_receipt_for_attempt_commit() {
    let f = Fixture::new();
    let legacy =
        f.r.prepare(
            &f.store,
            "assistant",
            Request {
                objective: "Recibo distinto".into(),
                target_ids: vec![3],
                max_operations: None,
                duration_seconds: None,
            },
            START,
        )
        .unwrap();
    f.r.consent(&f.store, "assistant", &legacy.id, START)
        .unwrap();
    f.r.execute(
        &f.store,
        "assistant",
        Execution {
            grant_id: legacy.id,
            request_id: "foreign-receipt".into(),
            target_id: 3,
            expected_revision: 3,
        },
        START,
    )
    .unwrap();
    let g = f.running();
    let mut a = f.admit(&g.id);
    // Synthetic old/inconsistent ledger collision: no task effect is injected here.
    f.store
        .connect()
        .unwrap()
        .execute(
            "UPDATE executor_attempts SET request_id='foreign-receipt' WHERE request_id=?1",
            [&a.key],
        )
        .unwrap();
    a.key = "foreign-receipt".into();
    a.execution.request_id = a.key.clone();
    f.r.executor_uncertain(&f.store, &a, START).unwrap();
    let blocked = f.state(&g.id);
    assert_eq!(blocked.status, "blocked");
    assert_eq!(blocked.attempts[0].status, "not_committed");
    assert_eq!(blocked.consumed, 0);
    assert_eq!(blocked.steps[0].status, "pending");
    let next =
        f.r.executor_review(&f.store, "dashboard", &g.id, START)
            .unwrap();
    f.r.executor_consent(&f.store, "dashboard", &next.grant.id, START)
        .unwrap();
    f.r.executor_start(&f.store, "dashboard", &next.grant.id, START)
        .unwrap();
    let fresh = f.admit(&g.id);
    assert_ne!(fresh.key, a.key);
    f.r.executor_commit(&f.store, &fresh, START, |_| Ok(()))
        .unwrap();
    assert_eq!(f.store.list().unwrap().revision, 5);
}

#[test]
fn conversational_preparation_checks_revision_and_does_not_grant_or_start() {
    let f = Fixture::new();
    assert!(f.r.executor_prepare_conversation(&f.store, "dashboard", f.proposal(), 2).is_err());
    let g = f.r.executor_prepare_conversation(&f.store, "assistant", f.proposal(), 3).unwrap();
    assert_eq!(g.owner, "assistant");
    assert_eq!(g.status, "draft");
    assert_eq!(g.grant.status, "draft");
    assert_eq!(g.consumed, 0);
    assert_eq!(f.store.list().unwrap().revision, 3);
    assert!(f.r.executor_consent(&f.store, "dashboard", &g.grant.id, LIVE).is_err());
    assert!(f.r.executor_start(&f.store, "assistant", &g.grant.id, LIVE).is_err());
}
