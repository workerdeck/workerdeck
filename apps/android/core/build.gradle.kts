import org.gradle.internal.os.OperatingSystem

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val repoRoot: File = rootDir.resolve("../..").canonicalFile
val cargoTarget: File = repoRoot.resolve("target")
val hostLib: File = cargoTarget.resolve(
    "release/" + when {
        OperatingSystem.current().isMacOsX -> "libwdffi.dylib"
        OperatingSystem.current().isWindows -> "wdffi.dll"
        else -> "libwdffi.so"
    },
)
val uniffiOut: Provider<Directory> = layout.buildDirectory.dir("generated/uniffi/kotlin")
val jniLibsOut: Provider<Directory> = layout.buildDirectory.dir("rustJniLibs")

fun Exec.cargoInputs() {
    workingDir = repoRoot
    inputs.dir(repoRoot.resolve("crates"))
    inputs.files(repoRoot.resolve("Cargo.toml"), repoRoot.resolve("Cargo.lock"), repoRoot.resolve("rust-toolchain.toml"))
}

val cargoHost by tasks.registering(Exec::class) {
    description = "Builds libwdffi and uniffi-bindgen for this machine: the bindgen's input and the JVM tests' library."
    cargoInputs()
    commandLine("cargo", "build", "-p", "wd-native-ffi", "--release", "--features", "cli")
    outputs.file(hostLib)
}

val uniffiKotlin by tasks.registering(Exec::class) {
    description = "Generates the UniFFI Kotlin bindings from the host library's metadata."
    dependsOn(cargoHost)
    workingDir = repoRoot
    inputs.file(hostLib)
    outputs.dir(uniffiOut)
    doFirst { delete(uniffiOut) }
    commandLine(
        cargoTarget.resolve("release/uniffi-bindgen").path,
        "generate", "--library", hostLib.path, "--language", "kotlin", "--no-format",
        "--out-dir", uniffiOut.get().asFile.path,
    )
}

val cargoNdk by tasks.registering(Exec::class) {
    description = "Cross-builds libwdffi.so for arm64-v8a and x86_64 with cargo-ndk."
    cargoInputs()
    outputs.dir(jniLibsOut)
    commandLine(
        "cargo", "ndk", "-t", "arm64-v8a", "-t", "x86_64",
        "-o", jniLibsOut.get().asFile.path,
        "build", "-p", "wd-native-ffi", "--release",
    )
}

android {
    namespace = "bi.atomic.workerdeck.core"
    compileSdk = 36
    defaultConfig {
        minSdk = 28
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets["main"].java.srcDir(uniffiOut)
    sourceSets["main"].jniLibs.srcDir(jniLibsOut)
    testOptions.unitTests.all {
        it.dependsOn(cargoHost)
        it.systemProperty("jna.library.path", hostLib.parentFile.path)
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

tasks.matching { it.name.startsWith("compile") && it.name.endsWith("Kotlin") }.configureEach { dependsOn(uniffiKotlin) }
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("JniLibFolders") }.configureEach { dependsOn(cargoNdk) }

dependencies {
    implementation("net.java.dev.jna:jna:5.17.0@aar")
    testImplementation("net.java.dev.jna:jna:5.17.0")
    testImplementation("junit:junit:4.13.2")
}
