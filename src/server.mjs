import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config, ensure, RuleError, id } from "./core.mjs";
import { Database } from "./database.mjs";
import { Service } from "./service.mjs";
export function createServer(db, c, mail) {
  const service = new Service(db, c, mail);
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    const origin = req.headers.origin;
    if (c.origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,Idempotency-Key",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    }
    const send = (body, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
      const url = new URL(req.url, "http://local"),
        path = url.pathname.replace(/\/$/, "");
      const query = Object.fromEntries(url.searchParams);
      if (path === "/v1/health" && req.method === "GET")
        return send({
          status: "ok",
          version: "0.1.0",
          commit: process.env.RENDER_GIT_COMMIT || null,
        });
      await db.rate("http:" + req.socket.remoteAddress, 1200, 60);
      let body = {};
      if (["POST", "PATCH"].includes(req.method)) {
        ensure(
          req.headers["content-type"]?.split(";")[0] === "application/json",
          "CONTENT_TYPE",
          "Envie JSON.",
          415,
        );
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          ensure(
            size <= 800000,
            "BODY_LIMIT",
            "Requisição acima do limite.",
            413,
          );
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new RuleError("INVALID_JSON", "JSON inválido.");
        }
      }
      const branding = path.match(
        /^\/v1\/branding\/([a-z0-9-]{1,60})(\/logo)?$/,
      );
      if (branding && req.method === "GET") {
        const company = await service.company(branding[1]);
        if (branding[2]) {
          const {
            rows: [row],
          } = await db.query("SELECT logo FROM company WHERE id=$1", [
            company.id,
          ]);
          ensure(row.logo, "NOT_FOUND", "Logo não cadastrada.", 404);
          res.writeHead(200, { "Content-Type": "image/webp" });
          return res.end(row.logo);
        }
        return send({
          name: company.name,
          primary_color: company.primary_color,
          accent_color: company.accent_color,
          logo_version: company.logo_version,
        });
      }
      if (
        req.method === "POST" &&
        ["/v1/sessions", "/v1/access/reset", "/v1/access/complete"].includes(
          path,
        )
      ) {
        await db.rate("auth:" + req.socket.remoteAddress, 100, 60);
        if (path === "/v1/sessions") return send(await service.login(body));
        if (path === "/v1/access/reset")
          return send(await service.requestReset(body));
        return send(await service.complete(body));
      }
      const auth = req.headers.authorization;
      const actor = await service.authenticate(
        auth?.startsWith("Bearer ") ? auth.slice(7) : null,
        requestId,
      );
      await db.rate("user:" + actor.company_id + ":" + actor.id, 600, 60);
      if (req.method === "GET" && path === "/v1/me")
        return send(await service.me(actor));
      if (req.method === "POST" && path === "/v1/logout") {
        await db.transaction(actor, (tx) =>
          tx.query("DELETE FROM session WHERE id=$1 AND company_id=$2", [
            actor.session_id,
            actor.company_id,
          ]),
        );
        return send({ revoked: true });
      }
      if (req.method === "PATCH" && path === "/v1/settings")
        return send(await service.settings(actor, body));
      if (req.method === "POST" && path === "/v1/logo")
        return send(await service.logo(actor, body));
      if (req.method === "GET" && path === "/v1/products")
        return send(await service.products(actor));
      if (req.method === "POST" && path === "/v1/products")
        return send(await service.product(actor, body), 201);
      let match = path.match(/^\/v1\/products\/([^/]+)$/);
      if (match && req.method === "PATCH")
        return send(await service.product(actor, body, match[1]));
      if (req.method === "POST" && path === "/v1/sales")
        return send(
          await service.createSale(actor, req.headers["idempotency-key"], body),
          201,
        );
      if (req.method === "GET" && path === "/v1/sales")
        return send(await service.sales(actor, query));
      match = path.match(/^\/v1\/sales\/([^/]+)(\/cancel)?$/);
      if (match) {
        if (req.method === "GET" && !match[2])
          return send(await service.sale(actor, match[1]));
        if (req.method === "POST" && match[2])
          return send(
            await service.cancel(
              actor,
              req.headers["idempotency-key"],
              match[1],
              body,
            ),
          );
      }
      if (req.method === "GET" && path === "/v1/dashboard")
        return send(await service.dashboard(actor, query));
      if (req.method === "GET" && path === "/v1/audit")
        return send(await service.audit(actor, query));
      if (req.method === "GET" && path === "/v1/users")
        return send(await service.users(actor));
      if (req.method === "POST" && path === "/v1/users")
        return send(await service.invite(actor, body), 201);
      match = path.match(/^\/v1\/users\/([^/]+)(\/invite)?$/);
      if (match) {
        if (req.method === "PATCH" && !match[2])
          return send(await service.user(actor, match[1], body));
        if (req.method === "POST" && match[2])
          return send(await service.invite(actor, body, match[1]));
      }
      throw new RuleError("NOT_FOUND", "Recurso não encontrado.", 404);
    } catch (e) {
      if (e instanceof z.ZodError)
        return send(
          {
            code: "INVALID_INPUT",
            message:
              "Confira os campos: " +
              e.issues
                .slice(0, 3)
                .map((v) => v.path.join(".") || "dados")
                .join(", "),
            requestId,
          },
          400,
        );
      if (e instanceof RuleError) {
        if (e.status === 429) res.setHeader("Retry-After", "60");
        return send({ code: e.code, message: e.message, requestId }, e.status);
      }
      if (["23505", "22P02", "22003"].includes(e.code))
        return send(
          {
            code: "DATA_CONFLICT",
            message:
              e.code === "23505"
                ? "SKU ou e-mail já cadastrado neste estabelecimento."
                : "Identificador ou valor inválido.",
            requestId,
          },
          409,
        );
      console.error(
        JSON.stringify({
          event: "request.failed",
          requestId,
          code: /^[0-9A-Z]{5}$/.test(e.code || "") ? e.code : "INTERNAL_ERROR",
        }),
      );
      send(
        {
          code: "INTERNAL_ERROR",
          message:
            "Não foi possível concluir a operação. Identificador: " + requestId,
          requestId,
        },
        500,
      );
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let db;
  try {
    const c = config();
    db = new Database(c.database);
    await db.query("SELECT 1 FROM company LIMIT 1");
    const server = createServer(db, c);
    server.listen(c.port, "0.0.0.0", () =>
      console.log("ERPBack 0.1.0 na porta " + c.port),
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () =>
        server.close(async () => {
          await db.close();
          process.exit(0);
        }),
      );
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "startup.failed",
        code: e.code || "CONFIG",
        message:
          e instanceof RuleError
            ? e.message
            : "Confira DATABASE_URL, migrations e variáveis do serviço.",
      }),
    );
    if (db) await db.close();
    process.exit(1);
  }
}
