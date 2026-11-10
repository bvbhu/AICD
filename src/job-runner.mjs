/**
 * Start a long-running tool action as a DSH background job.
 *
 * Jobs belong to the calling agent, survive the tool call, show live progress in
 * the UI, and are delivered as in-session completion notices by
 * `@deepseek-ai/dsh-tool-jobs`. The model collects the result with `job_output`
 * or cancels with `job_kill`; the conversation is free to continue meanwhile.
 */

export class JobUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'JobUnavailableError'
    this.code = 'jobs_unavailable'
  }
}

/**
 * @param ctx - plugin context (`ctx.get('jobs')` must resolve)
 * @param exec - tool execution context (agent/owner + call ids)
 * @param kind - job kind prefix (`gpt`, `gpt-image`)
 * @param label - one-line display label
 * @param task - async `({ signal, progress }) => result`; must honor the signal
 * @param formatResult - result => text appended to the job output ring
 * @returns the DSH job id (e.g. `gpt-1a2b...`)
 */
export function startBackgroundJob({ ctx, exec, kind, label, task, formatResult }) {
  const jobs = ctx.get('jobs')
  if (!jobs?.start) {
    throw new JobUnavailableError(
      '当前组合没有可用的后台任务服务（ctx.jobs）。请在使用该工具的预设里加载 @deepseek-ai/dsh-tool-jobs，它会同时提供 job_output/job_kill 和完成通知。',
    )
  }
  const controller = new AbortController()
  let cancelled = false
  const toolCall = exec?.callId !== undefined ? { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId } : undefined
  const id = jobs.start({
    kind,
    label: String(label || kind).replace(/\s+/g, ' ').slice(0, 160),
    ...(exec?.agent?.id ? { owner: exec.agent.id } : {}),
    ...(toolCall ? { toolCall } : {}),
    run: (handle) => {
      const done = (async () => {
        try {
          handle.updateProgress('运行中')
          const result = await task({
            signal: controller.signal,
            progress: (message) => {
              try {
                handle.updateProgress(String(message).replace(/\s+/g, ' ').slice(0, 160))
              } catch {
                /* progress must never fail the job */
              }
            },
          })
          if (cancelled || controller.signal.aborted) return { status: 'killed', detail: 'cancelled' }
          handle.append(formatResult(result))
          return { status: 'completed', detail: 'completed' }
        } catch (error) {
          if (cancelled || controller.signal.aborted) return { status: 'killed', detail: 'cancelled' }
          const message = String(error?.message || error)
          try {
            handle.append(`\n[gpt] 失败: ${message}\n`)
          } catch {
            /* the record still reports failed */
          }
          return { status: 'failed', detail: message.slice(0, 300) }
        }
      })()
      return {
        done,
        cancel: (reason) => {
          cancelled = true
          controller.abort(reason)
        },
      }
    },
  })
  return id
}
