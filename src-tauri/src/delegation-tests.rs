use super::*;
use crate::tasks::{TaskInput, TaskStore};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
const START: i64 = 1_800_000_000;
struct Fixture {
    store: TaskStore,
    path: std::path::PathBuf,
    runtime: DelegationRuntime,
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "jarvis-m2-unit-{}-{}.sqlite3",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let f = Self {
            store: TaskStore::new(path.clone()),
            path,
            runtime: DelegationRuntime::new().unwrap(),
        };
        for title in ["Primeira sintética", "Segunda sintética", "Fora do escopo"] {
            f.store
                .save(
                    None,
                    TaskInput {
                        title: title.into(),
                        description: "".into(),
                        priority: "normal".into(),
                        project: "".into(),
                        due_date: None,
                        due_time: None,
                    },
                )
                .unwrap();
        }
        f
    }
    fn request(&self) -> Request {
        Request {
            objective: "Concluir revisão sintética".into(),
            target_ids: vec![1, 2],
            max_operations: None,
            duration_seconds: None,
        }
    }
    fn draft(&self) -> Grant {
        self.runtime
            .prepare(&self.store, "dashboard", self.request(), START)
            .unwrap()
    }
    fn active(&self) -> Grant {
        let g = self.draft();
        self.runtime
            .consent(&self.store, "dashboard", &g.id, START)
            .unwrap()
    }
    fn execution(&self, g: &Grant, key: &str, id: i64, rev: i64) -> Execution {
        Execution {
            grant_id: g.id.clone(),
            request_id: key.into(),
            target_id: id,
            expected_revision: rev,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
#[test]
fn durable_consent_unitary_effect_and_exact_receipt() {
    let f = Fixture::new();
    let draft = f.draft();
    assert_eq!(draft.status, "draft");
    assert_eq!(draft.max_operations, 20);
    assert_eq!(draft.scope.as_ref().unwrap().duration_seconds, 1800);
    let e = f.execution(&draft, "one", 1, 3);
    assert!(f
        .runtime
        .execute(&f.store, "dashboard", e.clone(), START)
        .is_err());
    assert!(f
        .runtime
        .consent(&f.store, "assistant", &draft.id, START)
        .is_err());
    let active = f
        .runtime
        .consent(&f.store, "dashboard", &draft.id, START)
        .unwrap();
    assert_eq!(active.expires_at, Some(START + 1800));
    assert_eq!(
        f.runtime
            .consent(&f.store, "dashboard", &draft.id, START + 10)
            .unwrap()
            .expires_at,
        active.expires_at
    );
    let receipt = f
        .runtime
        .execute(&f.store, "dashboard", e.clone(), START + 1)
        .unwrap();
    assert_eq!(receipt.revision, 4);
    assert_eq!(receipt.used, 1);
    assert_eq!(receipt.target_id, 1);
    let saved = f.store.list().unwrap();
    assert!(saved.tasks[0].completed);
    assert!(!saved.tasks[1].completed);
    assert_eq!(
        receipt,
        f.runtime
            .execute(&f.store, "dashboard", e, START + 2)
            .unwrap()
    );
    assert_eq!(f.store.list().unwrap().revision, 4);
    let history = f.runtime.history(&f.store, "assistant", START + 2).unwrap();
    assert_eq!(history.receipts, vec![receipt]);
    assert_eq!(history.grants[0].used, 1);
}
#[test]
fn scope_origin_shape_and_stale_revision_fail_closed() {
    let f = Fixture::new();
    let g = f.active();
    for (window, id, rev, key) in [
        ("assistant", 1, 3, "foreign"),
        ("dashboard", 3, 3, "target"),
        ("dashboard", 1, 2, "stale"),
        ("dashboard", 0, 3, "zero"),
        ("dashboard", 1, 3, "invalid key"),
    ] {
        assert!(f
            .runtime
            .execute(&f.store, window, f.execution(&g, key, id, rev), START)
            .is_err());
    }
    assert!(serde_json::from_str::<Request>(
        r#"{"objective":"x","targetIds":[1],"operation":"delete_task"}"#
    )
    .is_err());
    assert!(serde_json::from_str::<Execution>(
        r#"{"grantId":"x","requestId":"a","targetId":1,"expectedRevision":3,"authorized":true}"#
    )
    .is_err());
    assert_eq!(f.store.list().unwrap().revision, 3);
    assert_eq!(
        f.runtime
            .history(&f.store, "dashboard", START)
            .unwrap()
            .grants[0]
            .used,
        0
    );
}
#[test]
fn request_limits_and_draft_revision_are_enforced() {
    let f = Fixture::new();
    for (max, duration, ids) in [
        (21, 1800, vec![1]),
        (0, 1800, vec![1]),
        (20, 1801, vec![1]),
        (20, 0, vec![1]),
        (20, 1800, vec![1, 1]),
        (20, 1800, vec![]),
        (20, 1800, vec![99]),
    ] {
        let mut r = f.request();
        r.max_operations = Some(max);
        r.duration_seconds = Some(duration);
        r.target_ids = ids;
        assert!(f.runtime.prepare(&f.store, "dashboard", r, START).is_err());
    }
    let draft = f.draft();
    f.store.complete(3, true).unwrap();
    assert!(f
        .runtime
        .consent(&f.store, "dashboard", &draft.id, START)
        .is_err());
    assert!(f
        .runtime
        .consent(&f.store, "dashboard", &draft.id, START + 900)
        .is_err());
    assert_eq!(f.store.list().unwrap().revision, 4);
}
#[test]
fn clock_expiry_termination_and_cross_window_revocation_stop_new_effects() {
    for reason in ["revoked", "cancelled", "completed"] {
        let f = Fixture::new();
        let g = f.active();
        let e = f.execution(&g, "one", 1, 3);
        let r = f
            .runtime
            .execute(&f.store, "dashboard", e.clone(), START)
            .unwrap();
        assert_eq!(
            f.runtime
                .end(&f.store, "assistant", &g.id, reason, START + 1)
                .unwrap()
                .status,
            reason
        );
        assert!(f
            .runtime
            .execute(
                &f.store,
                "dashboard",
                f.execution(&g, "two", 2, 4),
                START + 2
            )
            .is_err());
        assert_eq!(
            r,
            f.runtime
                .execute(&f.store, "dashboard", e, START + 3)
                .unwrap()
        );
        assert_eq!(f.store.list().unwrap().revision, 4);
    }
    let f = Fixture::new();
    let g = f.active();
    assert!(f
        .runtime
        .execute(
            &f.store,
            "dashboard",
            f.execution(&g, "early", 1, 3),
            START - 1
        )
        .is_err());
    assert!(f
        .runtime
        .execute(
            &f.store,
            "dashboard",
            f.execution(&g, "late", 1, 3),
            START + 1800
        )
        .is_err());
    assert_eq!(
        f.runtime
            .history(&f.store, "dashboard", START + 1800)
            .unwrap()
            .grants[0]
            .status,
        "expired"
    );
    assert_eq!(f.store.list().unwrap().revision, 3);
}
#[test]
fn restart_preserves_receipts_but_never_resumes_authority() {
    let f = Fixture::new();
    let g = f.active();
    let e = f.execution(&g, "committed", 1, 3);
    let r = f
        .runtime
        .execute(&f.store, "dashboard", e.clone(), START)
        .unwrap();
    let restarted = DelegationRuntime::new().unwrap();
    let store = TaskStore::new(f.path.clone());
    assert_eq!(
        r,
        restarted
            .execute(&store, "dashboard", e, START + 1)
            .unwrap()
    );
    assert!(restarted
        .execute(
            &store,
            "dashboard",
            f.execution(&g, "after-restart", 2, 4),
            START + 1
        )
        .is_err());
    assert_eq!(
        restarted
            .history(&store, "dashboard", START + 1)
            .unwrap()
            .grants[0]
            .status,
        "interrupted"
    );
    assert_eq!(store.list().unwrap().revision, 4);
}
#[test]
fn idempotency_collision_rejects_modified_parameters() {
    let f = Fixture::new();
    let g = f.active();
    let g2 = f.active();
    let e = f.execution(&g, "same", 1, 3);
    f.runtime.execute(&f.store, "dashboard", e, START).unwrap();
    for e in [
        f.execution(&g, "same", 2, 3),
        f.execution(&g, "same", 1, 4),
        f.execution(&g2, "same", 1, 3),
    ] {
        assert!(f.runtime.execute(&f.store, "dashboard", e, START).is_err());
    }
    assert_eq!(f.store.list().unwrap().revision, 4);
}
#[test]
fn every_transaction_boundary_rolls_back_and_retry_is_safe() {
    for stop in 0..=5 {
        let f = Fixture::new();
        let g = f.active();
        let e = f.execution(&g, "retry", 1, 3);
        assert!(f
            .runtime
            .execute_inner(
                &f.store,
                "dashboard",
                e.clone(),
                START,
                |at| if at == stop {
                    Err("synthetic failure".into())
                } else {
                    Ok(())
                }
            )
            .is_err());
        assert_eq!(f.store.list().unwrap().revision, 3);
        assert!(!f.store.list().unwrap().tasks[0].completed);
        let h = f.runtime.history(&f.store, "dashboard", START).unwrap();
        assert!(h.receipts.is_empty());
        assert_eq!(h.grants[0].used, 0);
        assert_eq!(
            f.runtime
                .execute(&f.store, "dashboard", e, START)
                .unwrap()
                .used,
            1
        );
    }
}
#[test]
fn sql_receipt_failure_rolls_back_actual_effect_and_budget() {
    let f = Fixture::new();
    let g = f.active();
    f.store.connect().unwrap().execute_batch("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON delegation_receipts BEGIN SELECT RAISE(ABORT,'synthetic'); END;").unwrap();
    assert!(f
        .runtime
        .execute(&f.store, "dashboard", f.execution(&g, "fail", 1, 3), START)
        .is_err());
    assert_eq!(f.store.list().unwrap().revision, 3);
    assert_eq!(
        f.runtime
            .history(&f.store, "dashboard", START)
            .unwrap()
            .grants[0]
            .used,
        0
    );
}
#[test]
fn independent_connections_cannot_overspend_or_duplicate_replay() {
    let f = Fixture::new();
    let mut request = f.request();
    request.max_operations = Some(1);
    let draft = f
        .runtime
        .prepare(&f.store, "dashboard", request, START)
        .unwrap();
    let g = f
        .runtime
        .consent(&f.store, "dashboard", &draft.id, START)
        .unwrap();
    let e1 = f.execution(&g, "first", 1, 3);
    let e2 = f.execution(&g, "second", 2, 3);
    let other = TaskStore::new(f.path.clone());
    let results = std::thread::scope(|scope| {
        let a = scope.spawn(|| f.runtime.execute(&f.store, "dashboard", e1, START));
        let b = scope.spawn(|| f.runtime.execute(&other, "dashboard", e2, START));
        [a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    let receipt = results.into_iter().find_map(Result::ok).unwrap();
    let e = f.execution(&g, &receipt.request_id, receipt.target_id, 3);
    std::thread::scope(|scope| {
        let a = scope.spawn(|| {
            f.runtime
                .execute(&f.store, "dashboard", e.clone(), START)
                .unwrap()
        });
        let b = scope.spawn(|| {
            f.runtime
                .execute(&other, "dashboard", e.clone(), START)
                .unwrap()
        });
        assert_eq!(a.join().unwrap(), b.join().unwrap());
    });
    let h = f.runtime.history(&f.store, "dashboard", START).unwrap();
    assert_eq!(h.grants[0].used, 1);
    assert_eq!(h.grants[0].status, "completed");
    assert_eq!(h.receipts.len(), 1);
    assert_eq!(f.store.list().unwrap().revision, 4);
}
#[test]
fn revocation_serializes_with_execution_and_never_admits_after_commit() {
    let f = Fixture::new();
    let g = f.active();
    let other = TaskStore::new(f.path.clone());
    std::thread::scope(|scope| {
        let a = scope.spawn(|| {
            f.runtime.execute(
                &f.store,
                "dashboard",
                f.execution(&g, "racing", 1, 3),
                START,
            )
        });
        let b = scope.spawn(|| f.runtime.end(&other, "assistant", &g.id, "revoked", START));
        let result = a.join().unwrap();
        b.join().unwrap().unwrap();
        assert_eq!(
            f.store.list().unwrap().revision,
            if result.is_ok() { 4 } else { 3 }
        );
    });
    assert!(f
        .runtime
        .execute(
            &f.store,
            "dashboard",
            f.execution(&g, "after", 2, f.store.list().unwrap().revision),
            START
        )
        .is_err());
}
#[test]
fn all_targets_done_and_retention_keep_only_security_tombstones() {
    let f = Fixture::new();
    let g = f.active();
    let e = f.execution(&g, "one", 1, 3);
    let first = f
        .runtime
        .execute(&f.store, "dashboard", e.clone(), START)
        .unwrap();
    f.runtime
        .execute(&f.store, "dashboard", f.execution(&g, "two", 2, 4), START)
        .unwrap();
    let h = f
        .runtime
        .history(&f.store, "assistant", START + RETENTION - 1)
        .unwrap();
    assert_eq!(h.grants[0].status, "completed");
    assert!(h.grants[0].scope.is_some());
    let h = f
        .runtime
        .history(&f.store, "assistant", START + RETENTION)
        .unwrap();
    assert!(h.grants[0].scope.is_none());
    assert_eq!(h.receipts.len(), 2);
    assert_eq!(
        first,
        f.runtime
            .execute(&f.store, "dashboard", e, START + RETENTION + 1)
            .unwrap()
    );
    assert_eq!(f.store.list().unwrap().revision, 5);
}
#[test]
fn schema_version_corruption_and_existing_v1_writes_fail_safely() {
    let f = Fixture::new();
    let g = f.active();
    f.store.complete_checked(3, true, Some(3)).unwrap();
    assert!(f
        .runtime
        .execute(&f.store, "dashboard", f.execution(&g, "stale", 1, 3), START)
        .is_err());
    f.store
        .connect()
        .unwrap()
        .execute("UPDATE delegation_meta SET version=2", [])
        .unwrap();
    assert!(f.runtime.history(&f.store, "dashboard", START).is_err());
    assert!(f
        .runtime
        .execute(
            &f.store,
            "dashboard",
            f.execution(&g, "wrong-version", 1, 4),
            START
        )
        .is_err());
    assert_eq!(f.store.list().unwrap().revision, 4);
}
#[test]
fn rejected_expiry_and_restart_persist_terminal_state_without_history_call() {
    for restart in [false, true] {
        let f = Fixture::new();
        let g = f.active();
        let runtime = if restart {
            DelegationRuntime::new().unwrap()
        } else {
            DelegationRuntime {
                epoch: f.runtime.epoch.clone(),
            }
        };
        let time = if restart { START + 1 } else { START + 1800 };
        assert!(runtime
            .execute(&f.store, "dashboard", f.execution(&g, "reject", 1, 3), time)
            .is_err());
        let conn = f.store.connect().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM delegation_grants WHERE id=?1",
                [&g.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, if restart { "interrupted" } else { "expired" });
        assert_eq!(f.store.list().unwrap().revision, 3);
        assert_eq!(
            runtime
                .consent(&f.store, "dashboard", &g.id, time)
                .unwrap()
                .status,
            status
        );
    }
}
#[test]
fn lock_wait_cannot_extend_authority_or_draft_lifetime() {
    let f = Fixture::new();
    let mut request = f.request();
    request.duration_seconds = Some(1);
    let draft = f
        .runtime
        .prepare(&f.store, "dashboard", request, LIVE)
        .unwrap();
    let g = f
        .runtime
        .consent(&f.store, "dashboard", &draft.id, LIVE)
        .unwrap();
    let mut conn = f.store.connect().unwrap();
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    std::thread::scope(|scope| {
        let a = scope.spawn(|| {
            f.runtime.execute(
                &f.store,
                "dashboard",
                f.execution(&g, "blocked", 1, 3),
                LIVE,
            )
        });
        std::thread::sleep(std::time::Duration::from_millis(1200));
        tx.commit().unwrap();
        assert!(a.join().unwrap().is_err());
    });
    assert_eq!(f.store.list().unwrap().revision, 3);
    assert_eq!(
        f.runtime
            .history(&f.store, "dashboard", LIVE)
            .unwrap()
            .grants[0]
            .status,
        "expired"
    );
}
#[test]
fn active_grant_cannot_be_hidden_by_newer_drafts() {
    let f = Fixture::new();
    let g = f.active();
    for offset in 1..=101 {
        f.runtime
            .prepare(&f.store, "dashboard", f.request(), START + offset)
            .unwrap();
    }
    let h = f
        .runtime
        .history(&f.store, "assistant", START + 102)
        .unwrap();
    assert!(h
        .grants
        .iter()
        .any(|row| row.id == g.id && row.status == "active"));
    f.runtime
        .end(&f.store, "assistant", &g.id, "revoked", START + 103)
        .unwrap();
    assert!(f
        .runtime
        .execute(
            &f.store,
            "dashboard",
            f.execution(&g, "denied", 1, 3),
            START + 104
        )
        .is_err());
}
#[test]
fn v1_completion_closes_all_matching_authority_before_reopen() {
    let f=Fixture::new();
    let draft=f.runtime.prepare(&f.store,"dashboard",f.request(),LIVE).unwrap();
    let first=f.runtime.consent(&f.store,"dashboard",&draft.id,LIVE).unwrap();
    let draft=f.runtime.prepare(&f.store,"assistant",f.request(),LIVE).unwrap();
    let second=f.runtime.consent(&f.store,"assistant",&draft.id,LIVE).unwrap();
    f.store.complete_checked(1,true,Some(3)).unwrap();
    assert_eq!(grant(&f.store.connect().unwrap(),&first.id).unwrap().status,"active");
    f.store.complete_checked(2,true,Some(4)).unwrap();
    for id in [&first.id,&second.id] {
        let g=grant(&f.store.connect().unwrap(),id).unwrap();
        assert_eq!(g.status,"completed");assert_eq!(g.used,0);assert!(g.ended_at.unwrap()>=g.granted_at.unwrap());
    }
    f.store.complete_checked(1,false,Some(5)).unwrap();
    assert!(f.runtime.execute(&f.store,"dashboard",f.execution(&first,"reopen-first",1,6),LIVE).is_err());
    assert!(f.runtime.execute(&f.store,"assistant",f.execution(&second,"reopen-second",1,6),LIVE).is_err());
    assert_eq!(f.store.list().unwrap().revision,6);
}
#[test]
fn failure_closing_authority_rolls_back_manual_task_and_revision() {
    let f=Fixture::new();
    let mut request=f.request();request.target_ids=vec![1];
    let draft=f.runtime.prepare(&f.store,"dashboard",request,LIVE).unwrap();
    let g=f.runtime.consent(&f.store,"dashboard",&draft.id,LIVE).unwrap();
    f.store.connect().unwrap().execute_batch("CREATE TRIGGER synthetic_close_failure BEFORE UPDATE OF status ON delegation_grants WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'synthetic'); END;").unwrap();
    assert!(f.store.complete_checked(1,true,Some(3)).is_err());
    assert!(!f.store.list().unwrap().tasks[0].completed);
    assert_eq!(f.store.list().unwrap().revision,3);
    assert_eq!(grant(&f.store.connect().unwrap(),&g.id).unwrap().status,"active");
}
#[test]
fn delegated_effect_also_closes_overlapping_grant_atomically() {
    let f=Fixture::new();let mut request=f.request();request.target_ids=vec![1];
    let d1=f.runtime.prepare(&f.store,"dashboard",request.clone(),LIVE).unwrap();
    let g1=f.runtime.consent(&f.store,"dashboard",&d1.id,LIVE).unwrap();
    let d2=f.runtime.prepare(&f.store,"assistant",request,LIVE).unwrap();
    let g2=f.runtime.consent(&f.store,"assistant",&d2.id,LIVE).unwrap();
    f.runtime.execute(&f.store,"dashboard",f.execution(&g1,"overlap",1,3),LIVE).unwrap();
    assert_eq!(grant(&f.store.connect().unwrap(),&g2.id).unwrap().status,"completed");
    f.store.complete_checked(1,false,Some(4)).unwrap();
    assert!(f.runtime.execute(&f.store,"assistant",f.execution(&g2,"overlap-reopened",1,5),LIVE).is_err());
    assert_eq!(f.store.list().unwrap().revision,5);
}
#[test]
fn expired_authority_keeps_expiry_reason_during_later_manual_completion() {
    let f=Fixture::new();let mut request=f.request();request.target_ids=vec![1];request.duration_seconds=Some(1);
    let draft=f.runtime.prepare(&f.store,"dashboard",request,LIVE).unwrap();
    let g=f.runtime.consent(&f.store,"dashboard",&draft.id,LIVE).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1200));
    f.store.complete_checked(1,true,Some(3)).unwrap();
    let closed=grant(&f.store.connect().unwrap(),&g.id).unwrap();
    assert_eq!(closed.status,"expired");assert_eq!(closed.ended_at,g.expires_at);assert_eq!(closed.used,0);
}
#[test]
fn explicit_manual_completion_after_restart_can_close_goal_without_resuming_it() {
    let f=Fixture::new();let draft=f.runtime.prepare(&f.store,"dashboard",f.request(),LIVE).unwrap();
    let g=f.runtime.consent(&f.store,"dashboard",&draft.id,LIVE).unwrap();
    let restarted=DelegationRuntime::new().unwrap();let store=TaskStore::new(f.path.clone());
    // Independent explicit manual/v1 actions, before any delegation hydration.
    store.complete_checked(1,true,Some(3)).unwrap();store.complete_checked(2,true,Some(4)).unwrap();
    let h=restarted.history(&store,"dashboard",LIVE).unwrap();
    let closed=h.grants.iter().find(|row|row.id==g.id).unwrap();assert_eq!(closed.status,"completed");assert_eq!(closed.used,0);assert!(h.receipts.is_empty());
    store.complete_checked(1,false,Some(5)).unwrap();
    assert!(restarted.execute(&store,"dashboard",f.execution(&g,"manual-after-restart",1,6),LIVE).is_err());
    assert_eq!(store.list().unwrap().revision,6);
}
