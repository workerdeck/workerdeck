plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "bi.atomic.workerdeck"
    compileSdk = 36
    defaultConfig {
        applicationId = "bi.atomic.workerdeck"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
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
            buildConfigField("String", "DEV_GATEWAY_URL", "\"http://10.0.2.2:8790\"")
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
    implementation("net.java.dev.jna:jna:5.17.0@aar")
    testImplementation("net.java.dev.jna:jna:5.17.0")
    testImplementation("junit:junit:4.13.2")
}
