import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, describe, it, expect } from "vitest";

const owner = "11111111-1111-4111-8111-111111111111";
const sr = "22222222-2222-4222-8222-222222222222";
const phone = "66666666-6666-4666-8666-666666666666";
const button = "77777777-7777-4777-8777-777777777777";
const IA = "356938035643809";
const IB = "356938035643800";

// Mirrors the exact call sequence the Products page and Stock Issue page make:
// create product -> register IMEIs / receive opening stock -> check_imei -> issue.
describe("product add -> SR issue user journey (PGlite)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY, raw_user_meta_data jsonb DEFAULT '{}'); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('app.user',true),'')::uuid $$;`);
    const files = readdirSync("drizzle/migrations").filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) await db.exec(readFileSync(`drizzle/migrations/${f}`, "utf8"));
    await db.exec(`INSERT INTO auth.users(id) VALUES('${owner}'),('${sr}'); SELECT set_config('app.user','${owner}',false);`);
  }, 120000);
  afterAll(async () => { await db?.close(); });
  async function one<T = any>(sql: string, params: any[] = []) { return (await db.query<T>(sql, params)).rows[0] as T; }

  it("product creation + IMEI registration stocks a smartphone", async () => {
    await db.query(`INSERT INTO products(id, name, model, price, is_smartphone, stock_qty) VALUES('${phone}','Redmi Note','13',20000,true,0)`);
    const n = (await one<{ register_imeis: number }>("SELECT register_imeis($1,$2::text[],14000)", [phone, [IA, IB]])).register_imeis;
    expect(n).toBe(2);
    expect((await one<{ n: number }>("SELECT count(*)::int n FROM imei_units WHERE status='in_stock'")).n).toBe(2);
    expect(Number((await one<{ cost_price: string }>(`SELECT cost_price FROM imei_units WHERE imei='${IA}'`)).cost_price)).toBe(14000);
  });

  it("button product opening stock enters through receive_stock", async () => {
    await db.query(`INSERT INTO products(id, name, price, is_smartphone, stock_qty) VALUES('${button}','Button Phone',3000,false,0)`);
    const batch = (await one<{ receive_stock: string }>("SELECT receive_stock($1,10,'opening','Opening stock at product creation',NULL,NULL)", [button])).receive_stock;
    expect(batch).toMatch(/^CH-/);
    expect((await one<{ q: number }>(`SELECT stock_qty q FROM products WHERE id='${button}'`)).q).toBe(10);
  });

  it("check_imei gates the issue scan", async () => {
    const ok = await one<{ check_imei: { ok: boolean } }>("SELECT check_imei($1,'issue',$2)", [IA, sr]);
    expect(ok.check_imei.ok).toBe(true);
    const bad = await one<{ check_imei: { ok: boolean } }>("SELECT check_imei($1,'issue',$2)", ["356938035643999", sr]);
    expect(bad.check_imei.ok).toBe(false);
  });

  it("issue moves stock to the SR with one challan number", async () => {
    const batch = (await one<{ issue_stock: string }>("SELECT issue_stock($1,$2::jsonb,NULL,$3)", [sr, JSON.stringify([
      { product_id: phone, imeis: [IA] },
      { product_id: button, qty: 4 },
    ]), "b0000000-0000-4000-8000-000000000001"])).issue_stock;
    expect(batch).toMatch(/^CH-/);
    expect((await one<{ status: string }>(`SELECT status FROM imei_units WHERE imei='${IA}'`)).status).toBe("with_salesman");
    expect((await one<{ q: number }>(`SELECT stock_qty q FROM products WHERE id='${button}'`)).q).toBe(6);
    expect((await one<{ h: number }>("SELECT holding_qty($1,$2) h", [sr, button])).h).toBe(4);
    // idempotent replay of the same issue returns the same challan, no double issue
    const again = (await one<{ issue_stock: string }>("SELECT issue_stock($1,$2::jsonb,NULL,$3)", [sr, "[]", "b0000000-0000-4000-8000-000000000001"])).issue_stock;
    expect(again).toBe(batch);
  });

  it("an over-quantity line rejects the WHOLE batch atomically", async () => {
    await expect(db.query("SELECT issue_stock($1,$2::jsonb,NULL,NULL)", [sr, JSON.stringify([
      { product_id: phone, imeis: [IB] },
      { product_id: button, qty: 999 },
    ])])).rejects.toThrow(/Not enough stock/);
    // the valid smartphone line must NOT have been applied on its own
    expect((await one<{ status: string }>(`SELECT status FROM imei_units WHERE imei='${IB}'`)).status).toBe("in_stock");
  });


  it("purchase requires valid non-empty smartphone IMEIs and records stock atomically", async () => {
    const product = "88888888-8888-4888-8888-888888888888";
    const supplier = "99999999-9999-4999-8999-999999999999";
    await db.query(`INSERT INTO suppliers(id,name) VALUES('${supplier}','Test supplier')`);
    await db.query(`INSERT INTO products(id,name,price,is_smartphone,stock_qty) VALUES('${product}','Test smartphone',20000,true,0)`);
    await expect(db.query("SELECT record_purchase($1,'[]'::jsonb,0,NULL,NULL)",[supplier])).rejects.toThrow(/At least one purchase item/);
    await expect(db.query("SELECT record_purchase($1,$2::jsonb,0,NULL,NULL)",[supplier,JSON.stringify([{product_id:product,cost_price:12000,imeis:["490154203237519"]}])])).rejects.toThrow(/Invalid IMEI checksum/);
    expect((await one<{n:number}>("SELECT count(*)::int n FROM imei_units WHERE product_id=$1",[product])).n).toBe(0);
    await db.query("SELECT record_purchase($1,$2::jsonb,12000,NULL,NULL)",[supplier,JSON.stringify([{product_id:product,cost_price:12000,imeis:["490154203237518"]}])]);
    expect((await one<{n:number}>("SELECT count(*)::int n FROM imei_units WHERE product_id=$1 AND status='in_stock'",[product])).n).toBe(1);
    expect((await one<{n:number}>("SELECT count(*)::int n FROM purchases WHERE supplier_id=$1",[supplier])).n).toBe(1);
  });

  it("an already-issued IMEI cannot be issued twice", async () => {
    await expect(db.query("SELECT issue_stock($1,$2::jsonb,NULL,NULL)", [sr, JSON.stringify([{ product_id: phone, imeis: [IA] }])])).rejects.toThrow(/not available/);
  });
});
