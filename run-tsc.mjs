import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const outputPath = 'tsc-output.txt';

try {
  const stdout = execSync('npx tsc -p tsconfig.json --noEmit', {
    encoding: 'utf8',
    timeout: 120000,
    cwd: process.cwd()
  });
  writeFileSync(outputPath, 'SUCCESS\n' + stdout);
} catch (e) {
  const content = [
    'FAILED',
    'EXIT CODE: ' + e.status,
    'STDOUT:',
    e.stdout || '(none)',
    'STDERR:',
    e.stderr || '(none)',
  ].join('\n');
  writeFileSync(outputPath, content);
}