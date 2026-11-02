// node test-serverurl.js : unit tests for serverurl.js (no Electron needed)
const { normalizeServer, serverFromArgv } = require('./serverurl');
let fails = 0;
const eq = (input, want) => {
  const got = normalizeServer(input), g = got.url || 'ERROR', ok = want === 'ERROR' ? !!got.error : got.url === want;
  if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(input)} -> ${g}${ok ? '' : '   (wanted ' + want + ')'}`);
};
// what people type today keeps working
eq('http://192.168.1.222:3000', 'http://192.168.1.222:3000');
eq('192.168.1.222:3000', 'http://192.168.1.222:3000');
eq('192.168.1.222', 'http://192.168.1.222');
eq('  http://192.168.1.222:3000/  ', 'http://192.168.1.222:3000');
eq('http://192.168.1.222:3000///', 'http://192.168.1.222:3000');
eq('HTTP://Server.Local:3000', 'http://server.local:3000');
// https and names
eq('https://taskdesk.hifocus.com', 'https://taskdesk.hifocus.com');
eq('https://taskdesk.hifocus.com/', 'https://taskdesk.hifocus.com');
eq('taskdesk.hifocus.com', 'https://taskdesk.hifocus.com');
eq('taskdesk.hifocus.com:8443', 'http://taskdesk.hifocus.com:8443');
eq('https://taskdesk.hifocus.com:8443', 'https://taskdesk.hifocus.com:8443');
eq('https://ec2-3-110-1-2.ap-south-1.compute.amazonaws.com', 'https://ec2-3-110-1-2.ap-south-1.compute.amazonaws.com');
eq('https://example.com/taskdesk/', 'https://example.com/taskdesk');
eq('example.com/taskdesk', 'https://example.com/taskdesk');
eq('taskdesk', 'http://taskdesk');
eq('taskdesk:3000', 'http://taskdesk:3000');
eq('localhost:3000', 'http://localhost:3000');
eq('localhost', 'http://localhost');
eq('[::1]:3000', 'http://[::1]:3000');
eq('"https://taskdesk.hifocus.com"', 'https://taskdesk.hifocus.com');
// refused
eq('', 'ERROR'); eq('   ', 'ERROR'); eq(null, 'ERROR'); eq(undefined, 'ERROR');
eq('ftp://example.com', 'ERROR'); eq('file:///etc/passwd', 'ERROR'); eq('javascript:alert(1)', 'ERROR'); eq('ws://example.com', 'ERROR');
eq('http://', 'ERROR'); eq('https:///path', 'ERROR');
eq('https://user:secret@example.com', 'ERROR'); eq('example.com?x=1', 'ERROR'); eq('https://example.com/#x', 'ERROR');
eq('two words.com', 'ERROR'); eq('http://exa mple.com', 'ERROR');
// the password never comes back out in a message
console.log(JSON.stringify(normalizeServer('https://user:secret@example.com')).includes('secret') ? 'FAIL secret in message' : 'PASS the refusal message does not repeat the password');
// command line
const a = (argv, want) => { const g = serverFromArgv(argv), ok = g === want; if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} argv ${JSON.stringify(argv)} -> ${JSON.stringify(g)}`); };
a(['TaskDesk.exe', '--server=https://x.example.com'], 'https://x.example.com');
a(['TaskDesk.exe', '--server', 'x.example.com'], 'x.example.com');
a(['TaskDesk.exe', '--autostart'], null);
a(['TaskDesk.exe', '--server', '--autostart'], null);
a(['TaskDesk.exe', '--autostart', '--server=192.168.1.5:3000'], '192.168.1.5:3000');
a([], null);
console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
