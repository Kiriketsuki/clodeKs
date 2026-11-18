export const meta = {
  name: 'clodeks-fanout',
  description: 'Fan out Codex CLI subagents through the clodeks:codex-exec agent and collect structured results',
  phases: [{ title: 'Codex', detail: 'one clodeks:codex-exec agent per task' }],
}

// Each agent is a Claude haiku turn that makes one `clodeks run` call. The Codex tokens bill
// to the ChatGPT login. The Claude wrapper turn is small but still counts against Claude limits.

const RESULT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    thread_id: { type: ['string', 'null'] },
    result: { type: ['object', 'null'] },
    text: { type: 'string' },
    error: { type: ['string', 'null'] },
  },
  required: ['ok', 'error'],
}

const ANSWER_SCHEMA = '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}'

const cwd = (args && args.cwd) || '.'
const tasks = (args && args.tasks) || [
  'What is 12 * 12? Answer with the number only.',
  'Name the capital city of Japan. One word.',
]

phase('Codex')
const results = await parallel(
  tasks.map((task, i) => () =>
    agent(`TASK: ${task}\nSCHEMA: ${ANSWER_SCHEMA}\nCWD: ${cwd}\nWRITE: false`, {
      label: `codex:${i}`,
      phase: 'Codex',
      agentType: 'clodeks:codex-exec',
      model: 'haiku',
      schema: RESULT,
    }),
  ),
)

const failed = results.filter(r => !r || !r.ok).length
if (failed) log(`${failed} of ${tasks.length} Codex agents failed`)
return tasks.map((task, i) => ({ task, ...(results[i] || { ok: false, error: 'agent returned nothing' }) }))
