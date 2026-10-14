plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("androidx.baselineprofile")
}

android {
    namespace = "bi.atomic.workerdeck"
    compileSdk = 36
    defaultConfig {
        applicationId = "bi.atomic.workerdeck"
        minSdk = 28
        targetSdk = 36
        // CI numbers its APKs by run, so each side-loaded build installs over the last one.
        val build = providers.gradleProperty("WD_BUILD_NUMBER").orNull?.toInt()
        versionCode = build ?: 1
        versionName = "0.1.0" + (build?.let { "+ci.$it" } ?: "")
        buildConfigField("String", "DEV_GATEWAY_URL", "\"\"")
        buildConfigField("String", "DEV_GATEWAY_KEY", "\"\"")
    }
    val uploadStore = providers.gradleProperty("WD_UPLOAD_STORE_FILE").orNull
    signingConfigs {
        if (uploadStore != null) {
            create("upload") {
                storeFile = file(uploadStore)
                storePassword = providers.gradleProperty("WD_UPLOAD_STORE_PASSWORD").get()
                keyAlias = providers.gradleProperty("WD_UPLOAD_KEY_ALIAS").get()
                keyPassword = providers.gradleProperty("WD_UPLOAD_KEY_PASSWORD").get()
            }
        }
    }
    buildTypes {
        debug {
            buildConfigField("String", "DEV_GATEWAY_URL", "\"http://127.0.0.1:8790\"")
            buildConfigField("String", "DEV_GATEWAY_KEY", "\"androiddevkey\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName(if (uploadStore != null) "upload" else "debug")
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging { jniLibs { useLegacyPackaging = false } }
    testOptions.unitTests.all {
        it.systemProperty("jna.library.path", rootDir.resolve("../../target/host").canonicalPath)
    }
}

// The benchmark builds install beside the everyday app (`.bench`), so a profile run never sees a real pairing, and
// open their pairing form on the private test gateway through `adb reverse`, which an emulator and a phone both reach.
androidComponents {
    onVariants { variant ->
        if (variant.name.startsWith("benchmark") || variant.name.startsWith("nonMinified")) {
            variant.applicationId.set("bi.atomic.workerdeck.bench")
            variant.buildConfigFields?.put("DEV_GATEWAY_URL", com.android.build.api.variant.BuildConfigField("String", "\"http://127.0.0.1:8790\"", null))
            variant.buildConfigFields?.put("DEV_GATEWAY_KEY", com.android.build.api.variant.BuildConfigField("String", "\"androiddevkey\"", null))
        }
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

tasks.matching { it.name.startsWith("test") && it.name.endsWith("UnitTest") }.configureEach { dependsOn(":core:cargoHost") }

dependencies {
    implementation(project(":core"))
    val bom = platform("androidx.compose:compose-bom:2025.10.00")
    implementation(bom)
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
    implementation("androidx.metrics:metrics-performance:1.0.0")
    baselineProfile(project(":baselineprofile"))
    implementation("net.java.dev.jna:jna:5.17.0@aar")
    testImplementation("net.java.dev.jna:jna:5.17.0")
    testImplementation("junit:junit:4.13.2")
}
