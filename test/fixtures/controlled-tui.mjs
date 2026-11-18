#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', text => {
  if (text.includes('finish\n')) process.exit(0)
})
setTimeout(() => process.exit(2), 3500).unref()
