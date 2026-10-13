fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args.get(1).cloned().unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures").into());
    let session = format!("{dir}/session.jsonl");
    let shell = format!("{dir}/shell.txt");
    match args.get(2).map(String::as_str) {
        Some("dump") => print!("{}", wd_native::bench::dump(&session)),
        Some("dump-vt") => print!("{}", wd_native::bench::dump_vt(&shell)),
        Some("live") => println!("{}", wd_native::bench::run_live(&session)),
        _ => println!("{}", wd_native::bench::run(&session, &shell)),
    }
}
