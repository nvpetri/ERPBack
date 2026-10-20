import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Database } from "../src/database.mjs";
import { hashPassword } from "../src/core.mjs";
import { createServer } from "../src/server.mjs";
const url = process.env.TEST_DATABASE_URL;
test(
  "sales platform integration with isolated PostgreSQL",
  { skip: !url, timeout: 120000 },
  async (t) => {
    assert.equal(new URL(url).pathname, "/erp_test");
    const db = new Database(url);
    let server;
    const mails = [];
    const config = {
      granted: ["DASHBOARD", "AUDIT"],
      origins: ["http://localhost:3000"],
      emailKey: "test-key",
      emailFrom: "test@example.test",
      panel: "http://localhost:3000",
    };
    const first = randomUUID(),
      second = randomUUID(),
      manager = randomUUID(),
      cashier = randomUUID(),
      other = randomUUID(),
      product = randomUUID(),
      weight = randomUUID(),
      foreign = randomUUID();
    const password = "integration-password-123";
    const passwordHash = await hashPassword(password);
    let token, cashierToken, saleId, saleVersion;
    try {
      await db.query(
        "INSERT INTO company(id,slug,name) VALUES($1,$2,$3),($4,$5,$6)",
        [first, "fixture-a", "Loja A", second, "fixture-b", "Loja B"],
      );
      for (const [id, company, email, role] of [
        [manager, first, "manager@example.test", "MANAGER"],
        [cashier, first, "cashier@example.test", "CASHIER"],
        [other, second, "manager@example.test", "MANAGER"],
      ])
        await db.query(
          "INSERT INTO app_user(id,company_id,name,email,password_hash,role,shared_account) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [id, company, role, email, passwordHash, role, role === "CASHIER"],
        );
      for (const [id, company, sku, unit, price] of [
        [product, first, "BREAD", "UN", 500],
        [weight, first, "KG", "KG", 1990],
        [foreign, second, "FOREIGN", "UN", 999],
      ])
        await db.query(
          "INSERT INTO product(id,company_id,sku,name,category,unit,price) VALUES($1,$2,$3,$3,$4,$5,$6)",
          [id, company, sku, "Alimentos", unit, price],
        );
      server = createServer(db, config, async (to, link, purpose) => {
        mails.push({ to, link, purpose });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = "http://127.0.0.1:" + server.address().port;
      async function request(path, body, auth = token, method, key) {
        const response = await fetch(origin + "/v1/" + path, {
          method: method || (body ? "POST" : "GET"),
          headers: {
            "Content-Type": "application/json",
            ...(auth ? { Authorization: "Bearer " + auth } : {}),
            ...(key ? { "Idempotency-Key": key } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, body: await response.json() };
      }
      const period = new URLSearchParams({
        from: new Date(Date.now() - 86400000).toISOString(),
        to: new Date(Date.now() + 86400000).toISOString(),
      }).toString();
      await t.test("authentication, role and company isolation", async () => {
        assert.equal((await request("products")).status, 401);
        const a = await request(
          "sessions",
          { slug: "fixture-a", email: "manager@example.test", password },
          null,
        );
        assert.equal(a.status, 200);
        token = a.body.accessToken;
        const c = await request(
          "sessions",
          { slug: "fixture-a", email: "cashier@example.test", password },
          null,
        );
        cashierToken = c.body.accessToken;
        const catalog = await request("products");
        assert.equal(catalog.body.items.length, 2);
        assert.ok(!catalog.body.items.some((p) => p.id === foreign));
        assert.equal(
          (
            await request(
              "products",
              { sku: "X", name: "X", category: "X", unit: "UN", price: 1 },
              cashierToken,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(
              "products/" + foreign,
              {
                sku: "F",
                name: "Foreign",
                category: "A",
                unit: "UN",
                price: 1,
                active: true,
                expectedVersion: 1,
              },
              token,
              "PATCH",
            )
          ).status,
          409,
        );
        assert.equal(
          (await request("users", undefined, cashierToken)).status,
          403,
        );
      });
      await t.test(
        "atomic sale, split payments and concurrent idempotent retries",
        async () => {
          const input = {
            channel: "COUNTER",
            items: [
              { productId: product, quantity: 2000, expectedVersion: 1 },
              { productId: weight, quantity: 250, expectedVersion: 1 },
            ],
            discount: 0,
            payments: [
              { method: "PIX", amount: 1000 },
              { method: "CASH", amount: 498, tendered: 1000 },
            ],
          };
          const key = randomUUID();
          const [a, b] = await Promise.all([
            request("sales", input, cashierToken, "POST", key),
            request("sales", input, cashierToken, "POST", key),
          ]);
          assert.equal(a.status, 201, JSON.stringify(a.body));
          assert.equal(b.status, 201);
          assert.equal(a.body.id, b.body.id);
          assert.equal(a.body.total, 1498);
          saleId = a.body.id;
          saleVersion = a.body.version;
          const detail = await request("sales/" + saleId);
          assert.equal(detail.body.items.length, 2);
          assert.equal(detail.body.payments.length, 2);
          assert.equal(
            (
              await db.query("SELECT count(*) FROM sale WHERE company_id=$1", [
                first,
              ])
            ).rows[0].count,
            "1",
          );
          const changed = await request(
            "sales",
            { ...input, discount: 1 },
            cashierToken,
            "POST",
            key,
          );
          assert.equal(changed.status, 409);
          const bad = await request(
            "sales",
            { ...input, payments: [{ method: "PIX", amount: 1 }] },
            cashierToken,
            "POST",
            randomUUID(),
          );
          assert.equal(bad.status, 400);
          assert.equal(
            (
              await db.query("SELECT count(*) FROM sale WHERE company_id=$1", [
                first,
              ])
            ).rows[0].count,
            "1",
          );
        },
      );
      await t.test(
        "server protects snapshot, channel, foreign products and manager-only discounts",
        async () => {
          await db.query(
            "UPDATE product SET price=600,version=2 WHERE company_id=$1 AND id=$2",
            [first, product],
          );
          const input = {
            channel: "COUNTER",
            items: [{ productId: product, quantity: 1000, expectedVersion: 1 }],
            discount: 0,
            payments: [{ method: "PIX", amount: 500 }],
          };
          assert.equal(
            (await request("sales", input, token, "POST", randomUUID())).status,
            409,
          );
          assert.equal(
            (
              await request(
                "sales",
                {
                  ...input,
                  items: [
                    { productId: foreign, quantity: 1000, expectedVersion: 1 },
                  ],
                },
                token,
                "POST",
                randomUUID(),
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await request(
                "sales",
                { ...input, channel: "TABLE" },
                token,
                "POST",
                randomUUID(),
              )
            ).status,
            403,
          );
          const detail = await request("sales/" + saleId);
          assert.equal(
            detail.body.items.find((i) => i.sku === "BREAD").price,
            500,
          );
          assert.equal(
            (
              await request(
                "sales",
                {
                  ...input,
                  discount: 1,
                  items: [
                    { productId: product, quantity: 1000, expectedVersion: 2 },
                  ],
                },
                cashierToken,
                "POST",
                randomUUID(),
              )
            ).status,
            403,
          );
        },
      );
      await t.test(
        "license and enabled modules are enforced by API and settings version",
        async () => {
          const before = await request("me");
          const c = before.body.company;
          const settings = {
            name: c.name,
            sector: c.sector,
            primary_color: c.primary_color,
            accent_color: c.accent_color,
            channels: c.channels,
            modules: [],
            expectedVersion: c.version,
          };
          assert.equal(
            (await request("settings", settings, token, "PATCH")).status,
            200,
          );
          assert.equal((await request("dashboard?" + period)).status, 403);
          assert.equal(
            (await request("settings", settings, token, "PATCH")).status,
            409,
          );
          assert.equal(
            (
              await request(
                "settings",
                {
                  ...settings,
                  modules: ["DASHBOARD", "AUDIT"],
                  expectedVersion: c.version + 1,
                },
                token,
                "PATCH",
              )
            ).status,
            200,
          );
          assert.equal(
            (await request("dashboard?" + period, undefined, cashierToken))
              .status,
            403,
          );
          const dashboard = await request("dashboard?" + period);
          assert.equal(dashboard.body.summary.revenue, "1498");
        },
      );
      await t.test(
        "cancel preserves history, refunds are not claimed and metrics exclude cancelled sales",
        async () => {
          assert.equal(
            (
              await request(
                "sales/" + saleId + "/cancel",
                { reason: "Operação incorreta", expectedVersion: saleVersion },
                cashierToken,
                "POST",
                randomUUID(),
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await request(
                "sales/" + saleId + "/cancel",
                { reason: "Operação incorreta", expectedVersion: saleVersion },
                token,
                "POST",
                randomUUID(),
              )
            ).status,
            200,
          );
          const dashboard = await request("dashboard?" + period);
          assert.equal(dashboard.body.summary.revenue, "0");
          assert.equal(dashboard.body.summary.cancelled, 1);
          assert.equal((await request("sales/" + saleId)).body.items.length, 2);
        },
      );
      await t.test(
        "invitations, reset, one-time use and session revocation",
        async () => {
          const result = await request("users", {
            name: "Funcionário",
            email: "invited@example.test",
            role: "CASHIER",
            shared_account: false,
          });
          assert.equal(result.status, 201, JSON.stringify(result.body));
          assert.equal(result.body.emailSent, true);
          assert.ok(!JSON.stringify(result.body).includes(mails.at(-1).link));
          const inviteToken = new URL(mails.at(-1).link).hash.slice(1);
          assert.equal(
            (
              await request(
                "access/complete",
                { token: inviteToken, password, name: "Nome completo" },
                null,
              )
            ).status,
            200,
          );
          assert.equal(
            (
              await request(
                "access/complete",
                { token: inviteToken, password },
                null,
              )
            ).status,
            400,
          );
          const login = await request(
            "sessions",
            { slug: "fixture-a", email: "invited@example.test", password },
            null,
          );
          const userToken = login.body.accessToken;
          assert.ok(userToken);
          assert.equal(
            (
              await request(
                "access/reset",
                { slug: "fixture-a", email: "invited@example.test" },
                null,
              )
            ).status,
            200,
          );
          const {
            rows: [resetAudit],
          } = await db.query(
            "SELECT actor_id FROM audit WHERE company_id=$1 AND table_name='invitation' AND operation='INSERT' AND after_data->>'purpose'='RESET' ORDER BY id DESC LIMIT 1",
            [first],
          );
          assert.equal(
            resetAudit.actor_id,
            null,
            "Public reset requests do not prove the account owner's identity",
          );
          const resetToken = new URL(mails.at(-1).link).hash.slice(1);
          assert.equal(
            (
              await request(
                "access/complete",
                { token: resetToken, password: "changed-password-123" },
                null,
              )
            ).status,
            200,
          );
          assert.equal((await request("me", undefined, userToken)).status, 401);
        },
      );
      await t.test(
        "audit redacts secrets, marks shared accounts and records direct SQL changes",
        async () => {
          const result = await request("audit?" + period);
          assert.equal(result.status, 200);
          assert.ok(
            result.body.items.some(
              (a) => a.table_name === "sale" && a.shared_account,
            ),
          );
          assert.ok(
            result.body.items.some(
              (a) => a.table_name === "product" && a.source === "SQL",
            ),
          );
          const text = JSON.stringify(result.body);
          assert.ok(!text.includes(passwordHash));
          assert.ok(!text.includes("invited@example.test"));
          await assert.rejects(
            db.query("DELETE FROM audit WHERE company_id=$1", [first]),
          );
          assert.equal(
            (await request("audit?" + period, undefined, cashierToken)).status,
            403,
          );
        },
      );
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      await db.close();
    }
  },
);
