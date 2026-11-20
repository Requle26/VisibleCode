use std::collections::BTreeMap;

#[derive(Debug)]
enum Event {
    Credit(i32),
    Transfer { amount: i32, recipient: String },
    Checkpoint,
}

#[derive(Debug)]
struct Ledger {
    owner: String,
    balances: BTreeMap<String, i32>,
}

impl Ledger {
    fn apply(&mut self, event: &Event) {
        match event {
            Event::Credit(amount) => *self.balances.entry(self.owner.clone()).or_default() += amount,
            Event::Transfer { amount, recipient } => {
                *self.balances.entry(self.owner.clone()).or_default() -= amount;
                *self.balances.entry(recipient.clone()).or_default() += amount;
            }
            Event::Checkpoint => eprintln!("checkpoint"),
        }
    }
}

fn weighted(values: &[i32]) -> i32 {
    match values.split_first() {
        Some((first, rest)) => first + 2 * weighted(rest),
        None => 0,
    }
}

fn main() {
    let mut ledger = Ledger { owner: String::from("민아"), balances: BTreeMap::new() };
    let mut events = vec![Event::Credit(12)];
    events.push(Event::Transfer { amount: 3, recipient: String::from("Noah") });
    events.push(Event::Checkpoint);
    let moved_events = events;
    for event in &moved_events {
        ledger.apply(event);
    }
    let balances: Vec<i32> = ledger.balances.values().copied().collect();
    let score = weighted(&balances);
    println!("{} / {} / {:?}", ledger.owner, score, balances);
}
