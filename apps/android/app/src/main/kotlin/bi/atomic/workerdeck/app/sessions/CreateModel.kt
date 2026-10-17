package bi.atomic.workerdeck.app.sessions

import android.content.Context
import bi.atomic.workerdeck.app.gateway.GatewayClient
import bi.atomic.workerdeck.core.ffi.CreateForm
import bi.atomic.workerdeck.core.ffi.CreateFormFields
import bi.atomic.workerdeck.core.ffi.CreateFormState
import bi.atomic.workerdeck.core.ffi.Created
import bi.atomic.workerdeck.core.ffi.HttpAnswer
import bi.atomic.workerdeck.core.ffi.SdkSession
import bi.atomic.workerdeck.core.ffi.createdAgent
import bi.atomic.workerdeck.core.ffi.createdSession
import bi.atomic.workerdeck.core.ffi.listProfilesCall
import bi.atomic.workerdeck.core.ffi.restError
import bi.atomic.workerdeck.core.ffi.sdkSessions
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

data class CreateUi(
    val fields: CreateFormFields,
    val state: CreateFormState,
    val loadingProfiles: Boolean = false,
    val submitting: Boolean = false,
    val error: String? = null,
)

// The create form over the core's `CreateForm`, which owns every field rule and builds the request; this moves bytes.
class CreateModel(private val form: CreateForm, val client: GatewayClient) {
    private val flow = MutableStateFlow(CreateUi(form.fields(), form.state()))
    val ui: StateFlow<CreateUi> = flow

    val modelPicker get() = form.modelPicker()
    val modePicker get() = form.modePicker()

    fun edit(change: (CreateFormFields) -> CreateFormFields) {
        form.update(change(form.fields()))
        reload()
    }

    suspend fun loadProfiles() {
        if (!flow.value.state.needsProfiles) return
        flow.value = flow.value.copy(loadingProfiles = true)
        val answer = client.answer(listProfilesCall())
        when {
            answer.status.toInt() == 404 -> form.setProfilesUnavailable()
            else -> failure(answer)?.let { flow.value = flow.value.copy(error = it) } ?: form.setProfiles(answer.body)
        }
        flow.value = flow.value.copy(loadingProfiles = false)
        reload()
    }

    // The stored sessions the chosen profile's engine could resume, scoped to the cwd field.
    suspend fun resumeCandidates(): Result<List<SdkSession>> {
        val answer = client.answer(form.resumeCandidatesCall())
        failure(answer)?.let { return Result.failure(IllegalStateException(it)) }
        return sdkSessions(answer.body, System.currentTimeMillis().toDouble())?.let { Result.success(it) }
            ?: Result.failure(IllegalStateException("The gateway sent stored sessions this app cannot read"))
    }

    fun adopt(stored: SdkSession) {
        form.adoptStoredSession(stored.sessionId, stored.cwd, stored.customTitle, stored.summary)
        reload()
    }

    suspend fun submit(): Created? {
        flow.value = flow.value.copy(submitting = true)
        val answer = client.answer(form.call())
        val error = failure(answer)
        val created = if (error == null) {
            if (flow.value.state.isAgent) createdAgent(answer.body) else createdSession(answer.body)
        } else null
        flow.value = flow.value.copy(
            submitting = false,
            error = error ?: if (created == null) "The gateway answered in a shape this app cannot read" else null,
        )
        return created
    }

    private fun failure(answer: HttpAnswer): String? =
        if (answer.status.toInt() == 0) "The gateway did not answer"
        else restError(answer.status, answer.contentType, answer.body)?.message

    private fun reload() {
        flow.value = flow.value.copy(fields = form.fields(), state = form.state())
    }
}

// The last few working directories a gateway started sessions in, newest first.
class RecentCwds(context: Context) {
    private val prefs = context.getSharedPreferences("recent-cwds", Context.MODE_PRIVATE)

    fun of(hostId: String): List<String> = prefs.getString(hostId, null)?.split('\n')?.filter { it.isNotEmpty() }.orEmpty()

    fun remember(hostId: String, cwd: String) {
        val trimmed = cwd.trim().takeIf { it.isNotEmpty() } ?: return
        val next = (listOf(trimmed) + of(hostId).filter { it != trimmed }).take(CAP)
        prefs.edit().putString(hostId, next.joinToString("\n")).apply()
    }

    fun forget(hostId: String) {
        prefs.edit().remove(hostId).apply()
    }

    private companion object {
        const val CAP = 8
    }
}
