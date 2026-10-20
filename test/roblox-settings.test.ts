import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RobloxSettings, defaultRobloxPreferences, parseRobloxPreferences, updateRobloxXml } from '../src/roblox-settings.js';

const xml = '<?xml version="1.0"?><roblox version="4"><Item class="UserGameSettings"><Properties>' +
  '<int name="FramerateCap">-1</int><float name="MasterVolume">0.5</float><bool name="Fullscreen">false</bool>' +
  '<token name="SavedQualityLevel">10</token><string name="Unrelated">keep &amp; preserve</string>' +
  '</Properties></Item><Item class="Other"><Properties><float name="MasterVolume">0.8</float></Properties></Item></roblox>';

test('Roblox settings validate only known options and preserve unrelated XML exactly', () => {
  const preferences = parseRobloxPreferences({ fpsCap: 144, masterVolume: 25, fullscreen: true, graphicsQuality: 5 });
  const updated = updateRobloxXml(xml, preferences);
  assert.ok(updated.includes('<int name="FramerateCap">144</int>'));
  assert.ok(updated.includes('<float name="MasterVolume">0.25</float>'));
  assert.ok(updated.includes('<bool name="Fullscreen">true</bool>'));
  assert.ok(updated.includes('<token name="SavedQualityLevel">5</token>'));
  assert.ok(updated.includes('<string name="Unrelated">keep &amp; preserve</string>'));
  assert.ok(updated.includes('<Item class="Other"><Properties><float name="MasterVolume">0.8</float>'));
  assert.throws(() => parseRobloxPreferences({ fpsCap: 99999 }));
  assert.throws(() => parseRobloxPreferences({ hideImages: 'false' }));
  assert.throws(() => parseRobloxPreferences({ arbitraryFlag: true }));
  assert.throws(() => updateRobloxXml('<invalid>', preferences));
  assert.throws(() => updateRobloxXml(xml, defaultRobloxPreferences));
});

test('saving preferences leaves the client untouched; applying creates a backup and refuses running clients', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roblox-preferences-'));
  try {
    const clientFile = join(root, 'GlobalBasicSettings_13.xml');
    const preferencesFile = join(root, 'roblox-settings.json');
    await writeFile(clientFile, xml);
    const settings = new RobloxSettings(preferencesFile, clientFile, async () => false);
    await settings.save({ fpsCap: 120, hideImages: true, maxRecentGames: 4 });
    assert.equal(await readFile(clientFile, 'utf8'), xml);
    await settings.apply();
    assert.equal(await readFile(`${clientFile}.multi-execute.bak`, 'utf8'), xml);
    assert.equal((await settings.snapshot()).client.values?.fpsCap, 120);
    await settings.save({ fpsCap: 60 });
    const runningSettings = new RobloxSettings(preferencesFile, clientFile, async () => true);
    await assert.rejects(runningSettings.apply(), /Feche todas as janelas/);
    assert.equal((await settings.snapshot()).client.values?.fpsCap, 120);
    await settings.apply();
    assert.equal((await settings.snapshot()).client.values?.fpsCap, 60);
    assert.equal(await readFile(`${clientFile}.multi-execute.bak`, 'utf8'), xml);
  } finally { await rm(root, { recursive: true, force: true }); }
});
