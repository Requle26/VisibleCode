macro_rules! record {
    ($value:expr) => {{ let internal = $value; println!("record {internal}"); }};
}

fn square(n: i32) -> i32 { n * n }

fn main() {
    let base = 3;
    let mut total = square(base); total += square(base + 1);
    {
        let base = total;
        record!(base);
    }
    let items = [base, total];
    let slice = &items[..];
    let mut owned = Box::new(items);
    let shared = &mut *owned;
    shared[0] = slice[1];
    println!("{base} / {total} / {:?}", owned);
}
