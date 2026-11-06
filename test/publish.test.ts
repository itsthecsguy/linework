import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publish } from '../src/publish.js';

function setup() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-proj-'));
  const drive = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-drive-'));
  fs.mkdirSync(path.join(proj, 'docs'));
  const file = path.join(proj, 'docs', 'a.drawio.svg');
  fs.writeFileSync(file, '<svg>v1</svg>');
  return { proj, drive, file, dest: path.join(drive, 'docs', 'a.drawio.svg') };
}

describe('publish', () => {
  it('copies, skips unchanged files and updates in place', () => {
    const { proj, drive, file, dest } = setup();
    expect(publish(['docs/a.drawio.svg'], { to: drive, cwd: proj })[0]!.action).toBe('published');
    expect(fs.readFileSync(dest, 'utf8')).toBe('<svg>v1</svg>');
    expect(publish(['docs/a.drawio.svg'], { to: drive, cwd: proj })[0]!.action).toBe('unchanged');
    fs.writeFileSync(file, '<svg>v2</svg>');
    const ino = fs.statSync(dest).ino;
    expect(publish(['docs/a.drawio.svg'], { to: drive, cwd: proj })[0]!.action).toBe('published');
    expect(fs.readFileSync(dest, 'utf8')).toBe('<svg>v2</svg>');
    expect(fs.statSync(dest).ino).toBe(ino); // same file, so Drive keeps its id
  });

  it('refuses to overwrite an edit made in Drive, and pulls it back', () => {
    const { proj, drive, file, dest } = setup();
    publish(['docs/a.drawio.svg'], { to: drive, cwd: proj });
    fs.writeFileSync(dest, '<svg>edited in docs</svg>');
    fs.writeFileSync(file, '<svg>v2 local</svg>');
    expect(publish(['docs/a.drawio.svg'], { to: drive, cwd: proj })[0]!.action).toBe('conflict');
    expect(fs.readFileSync(dest, 'utf8')).toBe('<svg>edited in docs</svg>');
    expect(publish(['docs/a.drawio.svg'], { to: drive, cwd: proj, pull: true })[0]!.action).toBe('pulled');
    expect(fs.readFileSync(file, 'utf8')).toBe('<svg>edited in docs</svg>');
    // after a pull the two match, and later local changes publish normally
    fs.writeFileSync(file, '<svg>v3</svg>');
    expect(publish(['docs/a.drawio.svg'], { to: drive, cwd: proj })[0]!.action).toBe('published');
  });

  it('--force overwrites a Drive edit', () => {
    const { proj, drive, file, dest } = setup();
    publish(['docs/a.drawio.svg'], { to: drive, cwd: proj });
    fs.writeFileSync(dest, '<svg>edited in docs</svg>');
    fs.writeFileSync(file, '<svg>mine</svg>');
    expect(publish(['docs/a.drawio.svg'], { to: drive, cwd: proj, force: true })[0]!.action).toBe('published');
    expect(fs.readFileSync(dest, 'utf8')).toBe('<svg>mine</svg>');
  });

  it('rejects files that are not diagrams', () => {
    const { proj, drive } = setup();
    fs.writeFileSync(path.join(proj, 'notes.md'), 'x');
    expect(() => publish(['notes.md'], { to: drive, cwd: proj })).toThrow(/drawio/);
  });
});
