import { randomBytes, scrypt as derive, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
const scrypt=promisify(derive);
export class RuleError extends Error {constructor(code,message,status=400){super(message);this.code=code;this.status=status;}}
export const ensure=(condition,code,message,status=400)=>{if(!condition)throw new RuleError(code,message,status);};
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const secret=()=>randomBytes(32).toString('base64url');
export async function hashPassword(password){const salt=randomBytes(16).toString('hex');const key=await scrypt(password,salt,64,{N:32768,r:8,p:3,maxmem:128*1024*1024});return `scrypt$v2$${salt}$${key.toString('hex')}`;}
export const dummyHash=`scrypt$v2$${'0'.repeat(32)}$${'0'.repeat(128)}`;
export async function verifyPassword(password,value){if(typeof password!=='string'||password.length>128)return false;const [,version,salt,key]=value.split('$');if(version!=='v2'||!salt||!key)return false;const actual=await scrypt(password,salt,64,{N:32768,r:8,p:3,maxmem:128*1024*1024});return timingSafeEqual(actual,Buffer.from(key,'hex'));}
export const id=z.uuid();
export const password=z.string().min(12).max(128);
export const email=z.email().max(254).transform(v=>v.toLowerCase().trim());
export const productSchema=z.strictObject({sku:z.string().trim().min(1).max(40),name:z.string().trim().min(1).max(100),category:z.string().trim().min(1).max(60),unit:z.enum(['UN','KG']),price:z.number().int().min(1).max(100000000),active:z.boolean().default(true)});
export const saleSchema=z.strictObject({channel:z.enum(['COUNTER','PICKUP','TABLE']),items:z.array(z.strictObject({productId:id,quantity:z.number().int().min(1).max(10000000),expectedVersion:z.number().int().positive()})).min(1).max(100),discount:z.number().int().min(0).max(100000000).default(0),payments:z.array(z.strictObject({method:z.enum(['CASH','PIX','CREDIT','DEBIT']),amount:z.number().int().min(1).max(100000000),tendered:z.number().int().min(1).max(100000000).optional()})).min(1).max(8)});
export function priceSale(input,products,role){
 const seen=new Set();let subtotal=0;
 const items=input.items.map(item=>{ensure(!seen.has(item.productId),'DUPLICATE_PRODUCT','Agrupe o mesmo produto em uma única linha.');seen.add(item.productId);
 const product=products.find(p=>p.id===item.productId);ensure(product?.active,'PRODUCT_UNAVAILABLE','Produto indisponível.',409);
 ensure(product.version===item.expectedVersion,'VERSION_CONFLICT','O produto foi alterado. Atualize o catálogo e revise a venda.',409);
 ensure(product.unit!=='UN'||item.quantity%1000===0,'INVALID_QUANTITY','Produtos por unidade exigem quantidade inteira.');
 const total=Number((BigInt(product.price)*BigInt(item.quantity)+500n)/1000n);ensure(total>0,'INVALID_QUANTITY','Quantidade abaixo do mínimo para o preço.');
 subtotal+=total;return {...product,quantity:item.quantity,total};});
 ensure(subtotal<=100000000,'TOTAL_LIMIT','Venda acima do limite de R$ 1.000.000.');
 ensure(role==='MANAGER'||input.discount===0,'FORBIDDEN','Somente gerente pode aplicar desconto.',403);
 ensure(input.discount<subtotal,'INVALID_DISCOUNT','O desconto deve ser menor que o subtotal.');
 const total=subtotal-input.discount;ensure(input.payments.reduce((sum,p)=>sum+p.amount,0)===total,'PAYMENT_MISMATCH','A soma dos recebimentos deve ser igual ao total.');
 for(const p of input.payments)ensure(p.method==='CASH'?p.tendered>=p.amount:p.tendered===undefined,'INVALID_PAYMENT','Informe o valor recebido em dinheiro; outros meios não recebem troco.');
 return {items,subtotal,total,discount:input.discount};
}
export const userDto=u=>({id:u.id,name:u.name,email:u.email,role:u.role,enabled:u.enabled,shared_account:u.shared_account,version:u.version,pending:!u.password_hash});
export function config(env=process.env){
 const production=env.NODE_ENV==='production';
 function url(key,required=true){if(!env[key]&&!required)return undefined;let value;try{value=new URL(env[key]);}catch{throw new Error(key+' ausente ou inválida.');}return value;}
 const database=url('DATABASE_URL');ensure(['postgres:','postgresql:'].includes(database.protocol),'CONFIG','DATABASE_URL deve apontar para PostgreSQL.');
 if(production)ensure(['require','verify-full'].includes(database.searchParams.get('sslmode')),'CONFIG','DATABASE_URL exige TLS.');
 const origins=(env.CORS_ORIGINS||'http://localhost:3000').split(',').filter(Boolean);for(const origin of origins){let parsed;try{parsed=new URL(origin);}catch{throw new Error('CORS_ORIGINS inválido.');}ensure(parsed.origin===origin&&(!production||parsed.protocol==='https:'),'CONFIG','CORS_ORIGINS exige origens exatas e HTTPS em produção.');}
 const granted=(env.LICENSE_MODULES||'DASHBOARD,AUDIT').split(',').filter(Boolean);ensure(granted.every(x=>['DASHBOARD','AUDIT'].includes(x)),'CONFIG','LICENSE_MODULES contém módulo desconhecido.');
 const panel=url('PANEL_URL',false);if(panel)ensure(panel.origin===env.PANEL_URL&&(!production||panel.protocol==='https:'),'CONFIG','PANEL_URL deve ser a origem exata do painel.');
 return {production,database:env.DATABASE_URL,origins,granted,port:Number(env.PORT||3001),panel:panel?.origin,emailKey:env.EMAIL_API_KEY,emailFrom:env.EMAIL_FROM||'ERP <onboarding@resend.dev>'};
}
