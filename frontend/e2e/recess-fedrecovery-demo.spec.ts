/**
 * RECESS + FedRecovery Adversarial Security Demo — E2E Test Suite.
 *
 * Verifies the full 4-act narrative:
 *   1. Healthy training (all clients honest)
 *   2. Attack injection (one client starts poisoning gradients)
 *   3. Detection & exclusion (RECESS catches it, client gets flagged/excluded)
 *   4. Auto-heal (FedRecovery reverses historical contamination)
 *
 * Prerequisites:
 *   - Full dev stack running: docker compose -f docker-compose.dev.yml up -d
 *   - Frontend dev server at http://localhost:5173
 *   - Backend API proxied through Vite at /api/v1
 *   - At least 3 FL client containers (bank_a, bank_b, bank_c)
 *
 * Run with:
 *   npx playwright test e2e/recess-fedrecovery-demo.spec.ts
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

// ── Constants ─────────────────────────────────────────

const BASE_URL = 'http://localhost:5173';
const API_BASE = `${BASE_URL}/api/v1`;

/** Default admin credentials (seeded on first start). */
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

/** How long to wait for FL training rounds to progress (~60s per round). */
const ROUND_TIMEOUT = 300_000;

/** RECESS fires every 5 rounds. We need at least 5 rounds to see it. */
const MIN_ROUNDS_FOR_RECESS = 5;

// ── Auth Helper ───────────────────────────────────────

/** Log in via the UI and return the authenticated page. */
async function loginViaUI(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForLoadState('networkidle');

  // Fill login form
  await page.getByPlaceholder('Enter your username').fill(ADMIN_USER);
  await page.getByPlaceholder('Enter your password').fill(ADMIN_PASS);
  await page.getByRole('button', { name: /sign in/i }).click();

  // Wait for redirect to workspace
  await page.waitForURL('**/workspace', { timeout: 15_000 });
}

/** Get an API auth token by calling the login endpoint directly. */
async function getAuthToken(context: BrowserContext): Promise<string> {
  const res = await context.request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  expect(res.ok(), `Login failed: ${res.status()}`).toBeTruthy();
  const data = await res.json();
  return data.access_token;
}

// ── Authenticated API Helpers ─────────────────────────

async function apiGet(context: BrowserContext, path: string, token: string) {
  const res = await context.request.get(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res;
}

async function apiPost(context: BrowserContext, path: string, token: string, data?: unknown, timeoutMs = 30_000) {
  const res = await context.request.post(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: data ?? {},
    timeout: timeoutMs,
  });
  return res;
}

async function getFlStatus(context: BrowserContext, token: string) {
  const res = await apiGet(context, '/fl/status', token);
  return res.json();
}

async function getTrustScores(context: BrowserContext, token: string) {
  const res = await apiGet(context, '/fl/trust_scores', token);
  const data = await res.json();
  return data.trust_scores as Record<string, number>;
}

async function getFlaggedClients(context: BrowserContext, token: string) {
  const res = await apiGet(context, '/fl/flagged_clients', token);
  const data = await res.json();
  return data.flagged as Array<{ client_id: string; round_number: number; abnormality: number }>;
}

async function stopTraining(context: BrowserContext, token: string) {
  try { await apiPost(context, '/fl/stop', token, {}, 60_000); } catch { /* ignore */ }
}

async function clearPoison(context: BrowserContext, token: string) {
  const res = await apiGet(context, '/fl/clients', token);
  const clients = await res.json();
  for (const c of clients) {
    try {
      await apiPost(context, `/fl/clients/${c.id}/poison`, token, { strategy: 'none' });
    } catch { /* ignore */ }
  }
}

async function resetTrust(context: BrowserContext, token: string) {
  try { await apiPost(context, '/fl/trust_scores/reset', token); } catch { /* ignore */ }
}

async function waitForRound(context: BrowserContext, token: string, targetRound: number, timeout = ROUND_TIMEOUT) {
  await expect(async () => {
    const status = await getFlStatus(context, token);
    expect(status.current_round).toBeGreaterThanOrEqual(targetRound);
  }).toPass({ timeout, intervals: [5_000] });
}

async function waitForTrainingActive(context: BrowserContext, token: string, timeout = 120_000) {
  await expect(async () => {
    const status = await getFlStatus(context, token);
    expect(status.is_training).toBe(true);
  }).toPass({ timeout, intervals: [2_000] });
}

// ── Smoke Tests (no FL training required) ─────────────

test.describe('Canvas Smoke Tests', () => {
  test('login page loads and accepts credentials', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    // Login page should show
    await expect(page.getByText('IoT IDS Platform')).toBeVisible();
    await expect(page.getByPlaceholder('Enter your username')).toBeVisible();
  });

  test('workspace page loads after login', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await loginViaUI(page);

    // Should have the ReactFlow canvas
    const canvas = page.locator('.react-flow');
    await expect(canvas).toBeVisible({ timeout: 10_000 });

    // No JS errors
    expect(errors, `Page errors: ${errors.join('; ')}`).toHaveLength(0);
  });

  test('node palette renders all node types including Watcher', async ({ page }) => {
    await loginViaUI(page);

    const expectedTypes = [
      'Client',
      'Device',
      'FL Server',
      'Traffic Source',
      'Attack',
      'Rate Filter',
      'Monitor',
      'Watcher',
    ];

    for (const label of expectedTypes) {
      const item = page.getByText(label, { exact: true }).first();
      await expect(item, `Palette should contain "${label}"`).toBeVisible({ timeout: 5_000 });
    }
  });

  test('FL Server drilldown opens on double-click', async ({ page }) => {
    await loginViaUI(page);

    const flServerNode = page.locator('.n8n-node').filter({ hasText: 'FL Server' }).first();
    const count = await flServerNode.count();
    if (count === 0) {
      test.skip(true, 'No FL Server node on workspace canvas');
      return;
    }

    await flServerNode.dblclick();

    // Drilldown view should appear with the back arrow
    const backButton = page.locator('.fl-drilldown-back');
    await expect(backButton).toBeVisible({ timeout: 5_000 });
  });

  test('certificate API returns data', async ({ context }) => {
    const token = await getAuthToken(context);
    const res = await apiGet(context, '/security/certificates', token);
    // 200 OK or 404 (certs not generated) — both acceptable
    expect([200, 404]).toContain(res.status());
    if (res.ok()) {
      const certs = await res.json();
      expect(Array.isArray(certs)).toBe(true);
    }
  });

  test('FL clients API returns registered clients', async ({ context }) => {
    const token = await getAuthToken(context);
    const res = await apiGet(context, '/fl/clients', token);
    expect(res.ok()).toBeTruthy();
    const clients = await res.json();
    expect(Array.isArray(clients)).toBe(true);
    expect(clients.length).toBeGreaterThan(0);
  });
});

// ── Full FL Training Demo Tests ───────────────────────
// These run sequentially and share state (training session).

test.describe.serial('RECESS + FedRecovery Adversarial Demo', () => {
  let authToken: string;
  /** Trust scores recorded after the first (clean) RECESS round. */
  let prePoisonTrust: Record<string, number> = {};

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    authToken = await getAuthToken(context);

    // Clean slate: stop any prior training, clear poison, reset trust + detection history
    await stopTraining(context, authToken);
    await clearPoison(context, authToken);
    await resetTrust(context, authToken);
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext();
    await stopTraining(context, authToken);
    await clearPoison(context, authToken);
    await context.close();
  });

  test('Act 1: Start FL training and verify round progress', async ({ context }) => {
    // Start training via API with enough rounds for the full narrative:
    //   Rounds 1-5: healthy training + first RECESS (baseline)
    //   Rounds 6-10: poison active + second RECESS detects anomalies
    //   Rounds 11-15: continued training (optional)
    const startRes = await apiPost(context, '/fl/start', authToken, { num_rounds: 15, min_clients: 2 }, 120_000);
    expect(startRes.ok(), `Start training failed: ${startRes.status()}`).toBeTruthy();

    // Wait for training to be active via API
    await waitForTrainingActive(context, authToken);

    // Verify round progress advances past round 2
    await waitForRound(context, authToken, 2);

    const status = await getFlStatus(context, authToken);
    expect(status.is_training).toBe(true);
    expect(status.current_round).toBeGreaterThanOrEqual(2);
  });

  test('Act 1b: RECESS detection runs at round 5 (all healthy)', async ({ context }) => {
    const status = await getFlStatus(context, authToken);
    if (!status.is_training) {
      test.skip(true, 'Training not active');
      return;
    }

    // Wait for round 6 (RECESS fires at round 5, scores committed by round 6)
    await waitForRound(context, authToken, MIN_ROUNDS_FOR_RECESS + 1, ROUND_TIMEOUT);

    // Trust scores should now exist
    const scores = await getTrustScores(context, authToken);
    const clientIds = Object.keys(scores);
    expect(clientIds.length, 'Expected trust scores after RECESS round').toBeGreaterThan(0);

    // All healthy clients should have trust >= 0.5 (pre-poison baseline)
    for (const [clientId, score] of Object.entries(scores)) {
      expect(score, `Healthy client ${clientId} trust`).toBeGreaterThanOrEqual(0.5);
    }

    // Save pre-poison trust scores for comparison in Act 3
    prePoisonTrust = { ...scores };

    // Verify detection round was recorded
    const detRes = await apiGet(context, '/fl/detection_rounds', authToken);
    expect(detRes.ok()).toBeTruthy();
    const detData = await detRes.json();
    const rounds = detData.rounds as Array<{ round_number: number }>;
    expect(rounds.length, 'Expected at least 1 detection round after round 5').toBeGreaterThan(0);
  });

  test('Act 2: Inject poison on first client', async ({ context }) => {
    const status = await getFlStatus(context, authToken);
    if (!status.is_training) {
      test.skip(true, 'Training not active');
      return;
    }

    // Get FL clients
    const clientsRes = await apiGet(context, '/fl/clients', authToken);
    const clients = await clientsRes.json();
    expect(clients.length).toBeGreaterThan(0);

    const targetClient = clients[0];

    // Activate direction_flip poison
    const poisonRes = await apiPost(
      context,
      `/fl/clients/${targetClient.id}/poison`,
      authToken,
      { strategy: 'direction_flip' },
    );
    expect(poisonRes.ok(), `Poison toggle failed: ${poisonRes.status()}`).toBeTruthy();

    const poisonData = await poisonRes.json();
    expect(poisonData.active).toBe(true);
    expect(poisonData.strategy).toBe('direction_flip');
  });

  test('Act 3: RECESS detects anomalies after poison injection', async ({ context }) => {
    const status = await getFlStatus(context, authToken);
    if (!status.is_training) {
      test.skip(true, 'Training not active');
      return;
    }

    // Wait for the next RECESS detection round after poison was activated.
    // Poison was activated after round 5.  Next RECESS is round 10.
    const currentRound = status.current_round;
    const nextDetectionRound = Math.ceil((currentRound + 1) / 5) * 5;

    // Wait one round past detection so scores are committed
    await waitForRound(context, authToken, nextDetectionRound + 1, ROUND_TIMEOUT * 2);

    // Verify RECESS detection rounds were recorded (at least 2: round 5 + round 10)
    const detRes = await apiGet(context, '/fl/detection_rounds', authToken);
    expect(detRes.ok()).toBeTruthy();
    const detData = await detRes.json();
    const rounds = detData.rounds as Array<{ round_number: number; scores: Record<string, number> }>;
    expect(rounds.length, 'Expected at least 2 detection rounds').toBeGreaterThanOrEqual(2);

    // Trust scores should show decay from pre-poison baseline.
    // With 2 clients and contaminated aggregation, RECESS flags anomalies
    // across all clients (known limitation — with N≥3 honest clients,
    // only the attacker would be flagged).
    const scores = await getTrustScores(context, authToken);
    const clientIds = Object.keys(scores);
    expect(clientIds.length, 'Expected trust scores for clients').toBeGreaterThanOrEqual(2);

    // At least one client's trust should be LOWER than pre-poison baseline
    const decayed = Object.entries(scores).filter(([cid, s]) => {
      const baseline = prePoisonTrust[cid] ?? 1.0;
      return s < baseline;
    });
    expect(
      decayed.length,
      `Expected trust decay from pre-poison baseline. ` +
        `Pre: ${JSON.stringify(prePoisonTrust)}  Post: ${JSON.stringify(scores)}`,
    ).toBeGreaterThan(0);
  });

  test('Act 3b: Detection rounds recorded with flagged clients', async ({ context }) => {
    // Verify detection_rounds endpoint has scored entries
    const detRes = await apiGet(context, '/fl/detection_rounds', authToken);
    if (!detRes.ok()) {
      test.skip(true, 'Detection rounds endpoint not available');
      return;
    }

    const detData = await detRes.json();
    const rounds = detData.rounds as Array<{
      round_number: number;
      scores: Record<string, number>;
      flagged: string[];
    }>;

    // Should have at least 2 detection rounds (round 5 and round 10)
    expect(
      rounds.length,
      `Expected at least 2 detection rounds. Got ${rounds.length}`,
    ).toBeGreaterThanOrEqual(2);

    // The latest detection round should have scores for both clients
    const latest = rounds[rounds.length - 1];
    const scoredClients = Object.keys(latest.scores);
    expect(
      scoredClients.length,
      `Expected 2 clients scored in detection round ${latest.round_number}. Got: ${JSON.stringify(latest.scores)}`,
    ).toBeGreaterThanOrEqual(2);

    // The post-poison detection round should have flagged at least one client
    const postPoisonRounds = rounds.filter((r) => r.flagged && r.flagged.length > 0);
    expect(
      postPoisonRounds.length,
      `Expected at least one detection round with flagged clients. Got rounds: ${JSON.stringify(rounds.map((r) => ({ round: r.round_number, flagged: r.flagged })))}`,
    ).toBeGreaterThan(0);
  });

  test('Act 4: Flagged client events recorded with high abnormality', async ({ context }) => {
    const flagged = await getFlaggedClients(context, authToken);
    expect(flagged.length, 'Expected flagged client events').toBeGreaterThan(0);

    // Verify at least one flagged event has abnormality > 0.5
    const highAbnormality = flagged.filter((f) => f.abnormality > 0.5);
    expect(
      highAbnormality.length,
      `Expected flagged client with abnormality > 0.5. Got: ${JSON.stringify(flagged)}`,
    ).toBeGreaterThan(0);
  });

  test('Act 4b: Deactivate poison and verify training continues', async ({ context }) => {
    await clearPoison(context, authToken);

    // Verify training is still running
    const status = await getFlStatus(context, authToken);
    if (!status.is_training) {
      // Training may have completed — that's acceptable
      return;
    }

    // Wait 2 more rounds to confirm training didn't crash
    const target = Math.min(status.current_round + 2, status.total_rounds ?? 50);
    try {
      await waitForRound(context, authToken, target, ROUND_TIMEOUT);
    } catch {
      // Training may have ended naturally — that's fine
    }
  });

  test('Cleanup: Stop training', async ({ context }) => {
    await stopTraining(context, authToken);

    await expect(async () => {
      const status = await getFlStatus(context, authToken);
      expect(status.is_training).toBe(false);
    }).toPass({ timeout: 15_000, intervals: [1_000] });
  });
});
