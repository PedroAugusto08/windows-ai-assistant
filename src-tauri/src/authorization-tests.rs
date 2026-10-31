#![cfg(test)]
// Isolated unit tests use only temporary databases, never application setup.
mod authorization;
mod delegation;
mod tasks;

mod conversation;
mod assistant_intelligence;
mod browser_search;
#[path = "habitual_intelligence.rs"]
mod intelligence;
mod weather;
