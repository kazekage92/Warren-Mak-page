#!/usr/bin/env node
/**
 * Encrypts a secret (e.g. an OpenAI API key) into the exact AES-256-GCM blob
 * format admin/index.html's decryptSecret() expects: base64(iv[12] + tag[16]
 * + ciphertext), keyed by SHA-256(password) — the same scheme already used
 * for CONFIG.ENCRYPTED_TOKEN (the GitHub PAT). Use this to produce
 * CONFIG.ENCRYPTED_OPENAI_KEY once a real OpenAI key exists — see
 * extra-md-files/ai-article-pipeline.md §6/§8 for background.
 *
 * The password is whatever the admin tool's login password already is — the
 * SAME password, not a new one. admin/index.html's decryptOpenAIKey() reuses
 * the login password to derive the AES key, exactly like decryptToken()
 * already does for the GitHub PAT — one password decrypts both blobs.
 *
 * Usage:
 *   node encrypt-secret.js --secret "sk-..." --password "..."
 *   node encrypt-secret.js --secret-file path/to/secret.txt --password "..."
 *
 * Prints the base64 blob to paste into CONFIG.ENCRYPTED_OPENAI_KEY in
 * admin/index.html (this format also works for CONFIG.ENCRYPTED_TOKEN,
 * they're identical). Never logs the password; the secret is only ever held
 * in memory, never written anywhere by this script.
 */

import { readFileSync } from 'node:fs';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextArg } from './cli-args.js';

function parseArgs(argv) {
  const opts = { secret: null, secretFile: null, password: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--secret':
        opts.secret = nextArg(argv, ++i, '--secret');
        break;
      case '--secret-file':
        opts.secretFile = nextArg(argv, ++i, '--secret-file');
        break;
      case '--password':
        opts.password = nextArg(argv, ++i, '--password');
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (!opts.secret && !opts.secretFile) throw new Error('--secret or --secret-file is required');
  if (!opts.password) throw new Error('--password is required');
  return opts;
}

/** SHA-256(password) as a raw 32-byte AES-256 key, AES-256-GCM encrypt with a
 *  fresh random 12-byte IV, output base64(iv + authTag + ciphertext) — the
 *  exact layout admin/index.html's decryptSecret() decodes (12/16/rest). */
export function encryptSecret(plaintext, password) {
  const key = createHash('sha256').update(password, 'utf-8').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const secret = opts.secret ?? readFileSync(opts.secretFile, 'utf-8').trim();
  console.log(encryptSecret(secret, opts.password));
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main();
}
