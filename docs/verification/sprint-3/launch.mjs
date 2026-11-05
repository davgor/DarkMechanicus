// node launch.mjs <build> <ud> <port> [agentdir]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
const [build, ud, port, agent] = process.argv.slice(2)
const B = String.fromCharCode(92), S = process.cwd()
const env = { ...process.env, DISABLE_AUTO_UPDATE: '1', DARKMECHANICUS_HOME: S + B + 'dmhome' }
delete env.ELECTRON_RUN_AS_NODE; delete env.PI_CODING_AGENT_DIR
if (agent) env.PI_CODING_AGENT_DIR = S + B + agent
const child = spawn(S + B + build + B + 'DarkMechanicus.exe', ['--user-data-dir=' + S + B + ud, '--remote-debugging-port=' + port, '--inspect=' + (Number(port) + 1)], { env, stdio: 'ignore', detached: true })
child.unref(); fs.writeFileSync(ud + '.pid', String(child.pid)); console.log('pid', child.pid)
