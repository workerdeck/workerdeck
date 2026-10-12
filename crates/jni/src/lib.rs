use jni::JNIEnv;
use jni::objects::{JByteArray, JClass, JString};
use jni::sys::{jbyteArray, jdouble, jint, jlong, jstring};
use wd_native::Engine;

fn engine<'a>(handle: jlong) -> Option<&'a mut Engine> {
    if handle == 0 {
        return None;
    }
    Some(unsafe { &mut *(handle as *mut Engine) })
}

fn bytes_out(env: &mut JNIEnv, bytes: &[u8]) -> jbyteArray {
    env.byte_array_from_slice(bytes)
        .map(|a| a.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_bi_atomic_workerdeck_core_NativeCore_create(
    _env: JNIEnv,
    _class: JClass,
    width_px: jdouble,
    cell_px: jdouble,
    line_px: jdouble,
) -> jlong {
    Box::into_raw(Box::new(Engine::new(width_px, cell_px, line_px, 120, 40))) as jlong
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_bi_atomic_workerdeck_core_NativeCore_ingest(
    env: JNIEnv,
    _class: JClass,
    handle: jlong,
    batch: JByteArray,
) -> jint {
    let Some(engine) = engine(handle) else {
        return 0;
    };
    let Ok(bytes) = env.convert_byte_array(&batch) else {
        return 0;
    };
    engine.ingest_batch(&bytes) as jint
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_bi_atomic_workerdeck_core_NativeCore_layout(_env: JNIEnv, _class: JClass, handle: jlong) {
    if let Some(engine) = engine(handle) {
        engine.layout();
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_bi_atomic_workerdeck_core_NativeCore_snapshot(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    max_lines: jint,
) -> jbyteArray {
    let Some(engine) = engine(handle) else {
        return std::ptr::null_mut();
    };
    let bytes = engine.snapshot(max_lines.max(0) as usize);
    bytes_out(&mut env, &bytes)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_bi_atomic_workerdeck_core_NativeCore_vtFeed(env: JNIEnv, _class: JClass, handle: jlong, data: JByteArray) {
    let Some(engine) = engine(handle) else { return };
    let Ok(bytes) = env.convert_byte_array(&data) else {
        return;
    };
    engine.vt.feed(&String::from_utf8_lossy(&bytes));
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_bi_atomic_workerdeck_core_NativeCore_vtSnapshot(mut env: JNIEnv, _class: JClass, handle: jlong) -> jbyteArray {
    let Some(engine) = engine(handle) else {
        return std::ptr::null_mut();
    };
    let bytes = engine.vt_snapshot();
    bytes_out(&mut env, &bytes)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_bi_atomic_workerdeck_core_NativeCore_bench(mut env: JNIEnv, _class: JClass, fixture_dir: JString) -> jstring {
    let dir: String = env.get_string(&fixture_dir).map(|s| s.into()).unwrap_or_default();
    let json = wd_native::bench::run(&format!("{dir}/session.jsonl"), &format!("{dir}/shell.txt"));
    env.new_string(json).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_bi_atomic_workerdeck_core_NativeCore_destroy(_env: JNIEnv, _class: JClass, handle: jlong) {
    if handle != 0 {
        drop(unsafe { Box::from_raw(handle as *mut Engine) });
    }
}
