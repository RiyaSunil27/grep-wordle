#!/usr/bin/env node

const readline = require('readline');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { WORD_LIST, SECRET_WORDS } = require('./words');

// ANSI colors
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgGray: '\x1b[100m',
  bgBlue: '\x1b[44m',
};

const MAX_GUESSES = 6;
const MAX_PROBES = 8;

// Temp file for grep operations
const WORDLIST_FILE = path.join(__dirname, '.wordlist.tmp');

function color(text, ...codes) {
  return codes.join('') + text + C.reset;
}

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function banner() {
  console.log(color('\n  ██████╗ ██████╗ ███████╗██████╗     ██╗    ██╗ ██████╗ ██████╗ ██████╗ ██╗     ███████╗', C.cyan, C.bold));
  console.log(color('  ██╔════╝ ██╔══██╗██╔════╝██╔══██╗    ██║    ██║██╔═══██╗██╔══██╗██╔══██╗██║     ██╔════╝', C.cyan, C.bold));
  console.log(color('  ██║  ███╗██████╔╝█████╗  ██████╔╝    ██║ █╗ ██║██║   ██║██████╔╝██║  ██║██║     █████╗  ', C.cyan, C.bold));
  console.log(color('  ██║   ██║██╔══██╗██╔══╝  ██╔═══╝     ██║███╗██║██║   ██║██╔══██╗██║  ██║██║     ██╔══╝  ', C.cyan, C.bold));
  console.log(color('  ╚██████╔╝██║  ██║███████╗██║         ╚███╔███╔╝╚██████╔╝██║  ██║██████╔╝███████╗███████╗', C.cyan, C.bold));
  console.log(color('   ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝          ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝ ╚══════╝╚══════╝', C.cyan, C.bold));
  console.log();
  console.log(color('  Use grep patterns to hunt the secret 5-letter word!', C.white, C.bold));
  console.log();
}

function printHelp() {
  console.log(color('─'.repeat(60), C.dim));
  console.log(color('HOW TO PLAY:', C.bold, C.yellow));
  console.log();
  console.log(`  ${color('PROBE:', C.cyan, C.bold)} Run a grep pattern against the word list`);
  console.log(`         ${color('grep <pattern>', C.green)}  →  see matching words`);
  console.log();
  console.log(`  ${color('GUESS:', C.magenta, C.bold)} Type any 5-letter word to guess`);
  console.log(`         Just type the word and press Enter`);
  console.log();
  console.log(color('FEEDBACK:', C.bold, C.yellow));
  console.log(`  ${color('█', C.bgGreen)} ${color('GREEN', C.green, C.bold)}  = right letter, right position`);
  console.log(`  ${color('█', C.bgYellow)} ${color('YELLOW', C.yellow, C.bold)} = right letter, wrong position`);
  console.log(`  ${color('█', C.bgGray)} ${color('GRAY', C.white)}   = letter not in word`);
  console.log();
  console.log(color('GREP PATTERN TIPS:', C.bold, C.yellow));
  console.log(`  ${color('^a....', C.green)}     word starts with 'a'`);
  console.log(`  ${color('....e$', C.green)}     word ends with 'e'`);
  console.log(`  ${color('.*tion', C.green)}     word contains 'tion'`);
  console.log(`  ${color('^[aeiou]', C.green)}   word starts with vowel`);
  console.log(`  ${color('^..[aeiou]', C.green)} 3rd letter is vowel`);
  console.log(`  ${color('-v ".*a.*"', C.green)}  does NOT contain 'a'`);
  console.log();
  console.log(color(`  Probes left: use wisely! Max ${MAX_PROBES} probes + ${MAX_GUESSES} guesses.`, C.dim));
  console.log(color('─'.repeat(60), C.dim));
  console.log();
}

function pickSecretWord() {
  return SECRET_WORDS[Math.floor(Math.random() * SECRET_WORDS.length)];
}

function writeWordlist() {
  fs.writeFileSync(WORDLIST_FILE, WORD_LIST.join('\n') + '\n');
}

function cleanup() {
  try { fs.unlinkSync(WORDLIST_FILE); } catch (_) {}
}

function runGrep(pattern, words) {
  // Parse the grep command - support flags like -v, -i, -E
  const parts = parseGrepArgs(pattern);
  if (!parts) return { error: 'Invalid grep command. Use: grep [flags] "pattern"' };

  const { flags, pat } = parts;

  try {
    // Build safe grep command against our temp file
    const flagStr = flags.length ? '-' + flags.join('') : '';
    const cmd = `grep ${flagStr} "${pat.replace(/"/g, '\\"')}" "${WORDLIST_FILE}" 2>&1`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 2000 }).trim();
    const matches = result ? result.split('\n').filter(w => WORD_LIST.includes(w)) : [];
    return { matches, cmd: `grep ${flagStr} "${pat}"` };
  } catch (e) {
    if (e.status === 1) return { matches: [], cmd: `grep ${flags.length ? '-' + flags.join('') : ''} "${pat}"` };
    return { error: `grep error: ${e.stderr || e.message}` };
  }
}

function parseGrepArgs(input) {
  // Strip leading "grep " if user typed it
  let s = input.trim();
  if (s.startsWith('grep ')) s = s.slice(5).trim();

  const flags = [];
  // Extract flags like -v, -i, -E, -iE etc
  const flagMatch = s.match(/^(-[viEe]+\s+)*/);
  if (flagMatch && flagMatch[0]) {
    const flagStr = flagMatch[0].trim();
    for (const m of flagStr.matchAll(/-([viEe]+)/g)) {
      flags.push(...m[1].split(''));
    }
    s = s.slice(flagMatch[0].length).trim();
  }

  // Remove wrapping quotes if present
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }

  if (!s) return null;
  return { flags: [...new Set(flags)], pat: s };
}

function scoreGuess(guess, secret) {
  const result = Array(5).fill('gray');
  const secretArr = secret.split('');
  const guessArr = guess.split('');
  const used = Array(5).fill(false);

  // First pass: exact matches
  for (let i = 0; i < 5; i++) {
    if (guessArr[i] === secretArr[i]) {
      result[i] = 'green';
      used[i] = true;
    }
  }

  // Second pass: wrong position
  for (let i = 0; i < 5; i++) {
    if (result[i] === 'green') continue;
    for (let j = 0; j < 5; j++) {
      if (!used[j] && guessArr[i] === secretArr[j]) {
        result[i] = 'yellow';
        used[j] = true;
        break;
      }
    }
  }

  return result;
}

function renderGuess(guess, colors) {
  const boxColors = { green: C.bgGreen, yellow: C.bgYellow, gray: C.bgGray };
  let line = '  ';
  for (let i = 0; i < 5; i++) {
    line += boxColors[colors[i]] + C.bold + ` ${guess[i].toUpperCase()} ` + C.reset + ' ';
  }
  return line;
}

function renderEmptyRow() {
  return '  ' + Array(5).fill(C.dim + '[ ]' + C.reset).join(' ');
}

function renderGuessList(guesses) {
  console.log();
  for (let i = 0; i < MAX_GUESSES; i++) {
    if (i < guesses.length) {
      console.log(renderGuess(guesses[i].word, guesses[i].colors));
    } else {
      console.log(renderEmptyRow());
    }
  }
  console.log();
}

function renderLetterBank(guesses) {
  const state = {}; // letter -> best state (green > yellow > gray)
  const priority = { green: 3, yellow: 2, gray: 1 };

  for (const { word, colors } of guesses) {
    for (let i = 0; i < 5; i++) {
      const ch = word[i];
      if (!state[ch] || priority[colors[i]] > priority[state[ch]]) {
        state[ch] = colors[i];
      }
    }
  }

  const bgColors = { green: C.bgGreen, yellow: C.bgYellow, gray: C.bgGray };
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  console.log(color('  Letters:', C.dim));
  for (const row of rows) {
    let line = '  ';
    for (const ch of row) {
      if (state[ch]) {
        line += bgColors[state[ch]] + C.bold + ` ${ch.toUpperCase()} ` + C.reset;
      } else {
        line += C.dim + `[${ch.toUpperCase()}]` + C.reset;
      }
      line += ' ';
    }
    console.log(line);
  }
  console.log();
}

function renderStatus(probesLeft, guessesLeft, probeHistory) {
  console.log(color(`  Probes: ${probesLeft}/${MAX_PROBES} remaining  |  Guesses: ${guessesLeft}/${MAX_GUESSES} remaining`, C.dim));
  if (probeHistory.length > 0) {
    console.log(color('  Recent probes:', C.dim));
    for (const p of probeHistory.slice(-3)) {
      const matchStr = p.matches.length === 0
        ? color('no matches', C.red)
        : color(`${p.matches.length} match${p.matches.length !== 1 ? 'es' : ''}`, C.green);
      console.log(color(`    ${p.cmd}`, C.cyan) + color(' → ', C.dim) + matchStr);
      if (p.matches.length > 0 && p.matches.length <= 15) {
        console.log(color(`      ${p.matches.join(', ')}`, C.white));
      } else if (p.matches.length > 15) {
        console.log(color(`      ${p.matches.slice(0, 10).join(', ')}... and ${p.matches.length - 10} more`, C.white));
      }
    }
  }
  console.log();
}

async function main() {
  clearScreen();
  banner();
  printHelp();

  writeWordlist();

  const secret = pickSecretWord();
  const guesses = [];
  const probeHistory = [];
  let probesLeft = MAX_PROBES;
  let guessesLeft = MAX_GUESSES;
  let won = false;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

  const redraw = () => {
    clearScreen();
    banner();
    renderGuessList(guesses);
    renderLetterBank(guesses);
    renderStatus(probesLeft, guessesLeft, probeHistory);
  };

  redraw();

  while (!won && guessesLeft > 0) {
    let input;
    try {
      input = await ask(color('  > ', C.bold, C.cyan));
    } catch (_) {
      break;
    }
    input = input.trim();

    if (!input) continue;

    if (input === 'quit' || input === 'exit') {
      console.log(color(`\n  The word was: ${secret.toUpperCase()}`, C.bold, C.yellow));
      break;
    }

    if (input === 'help' || input === '?') {
      redraw();
      printHelp();
      continue;
    }

    // Detect probe (starts with "grep" or contains regex special chars without being 5 alpha)
    const isGrep = input.startsWith('grep ') || input.startsWith('grep\t');
    const isPureWord = /^[a-z]{5}$/i.test(input);

    if (isGrep) {
      if (probesLeft <= 0) {
        redraw();
        console.log(color('  No probes left! Make a guess.', C.red, C.bold));
        continue;
      }

      const result = runGrep(input, WORD_LIST);
      if (result.error) {
        redraw();
        console.log(color(`  Error: ${result.error}`, C.red));
        continue;
      }

      probesLeft--;
      probeHistory.push({ cmd: result.cmd, matches: result.matches });
      redraw();

    } else if (isPureWord) {
      const word = input.toLowerCase();

      if (word.length !== 5) {
        redraw();
        console.log(color('  Must be exactly 5 letters!', C.red));
        continue;
      }

      if (!WORD_LIST.includes(word)) {
        redraw();
        console.log(color(`  "${word}" not in word list. Try another word.`, C.red));
        continue;
      }

      const colors = scoreGuess(word, secret);
      guesses.push({ word, colors });
      guessesLeft--;

      redraw();

      if (word === secret) {
        won = true;
        const usedProbes = MAX_PROBES - probesLeft;
        const usedGuesses = MAX_GUESSES - guessesLeft + 1;
        console.log(color('  ★ YOU GOT IT! ★', C.green, C.bold));
        console.log(color(`  Word: ${secret.toUpperCase()}`, C.green, C.bold));
        console.log();
        console.log(color(`  Probes used: ${usedProbes}/${MAX_PROBES}`, C.cyan));
        console.log(color(`  Guesses used: ${usedGuesses}/${MAX_GUESSES}`, C.cyan));
        const score = Math.max(0, 100 - usedProbes * 5 - usedGuesses * 10);
        console.log(color(`  Score: ${score}/100`, C.yellow, C.bold));
        console.log();
      } else if (guessesLeft === 0) {
        console.log(color(`  Game over! The word was: ${color(secret.toUpperCase(), C.green, C.bold)}`, C.red, C.bold));
        console.log();
      }
    } else {
      redraw();
      console.log(color('  Type a 5-letter word to guess, or "grep <pattern>" to probe.', C.yellow));
      console.log(color('  Type "help" for tips.', C.dim));
    }
  }

  cleanup();
  rl.close();
}

main().catch(err => {
  console.error(err);
  cleanup();
  process.exit(1);
});
