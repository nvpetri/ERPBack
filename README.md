# ERPBack · 0.1.0

API de vendas internas, derivada dos padrões de autenticação, auditoria e operação do Bonamassa. Produto independente; não modifica Bonamassa, seus bancos ou deploys.

## Escopo desta versão

- Catálogo genérico com SKU, categoria, preço, ativação, venda por unidade (UN) ou quilograma (KG).
- Venda finalizada no atendimento interno; frentes Balcão, Retirada e Mesas configuráveis. Mesas é uma classificação de canal: não inclui comandas abertas ou gestão de ocupação.
- Quantidade em milésimos: 1 unidade = 1000; 250 gramas = 250. UN exige múltiplo de 1000. Dinheiro em centavos, aritmética inteira e arredondamento por item, metade para cima.
- Preços obtidos no servidor com controle de versão. Venda guarda snapshots imutáveis em sale_item e recebimentos em payment. Desconto absoluto somente para gerente, menor que o subtotal.
- Recebimentos divididos em Pix, dinheiro, crédito e débito; troco apenas em dinheiro. São registros manuais: não há cobrança, confirmação bancária, TEF, gateway ou estorno automático.
- Cancelamento por gerente com justificativa e controle de versão, preservando itens e pagamentos. Venda cancelada é excluída do faturamento exibido. Devolução real deve ser feita fora do sistema no meio de pagamento original.
- Histórico paginado, indicadores por período/canal/produto, equipe por convite e auditoria append-only com triggers PostgreSQL.
- Identidade visual: nome, segmento, cores e logo PNG/JPEG/WebP de até 500 KB, normalizada em WebP. Não armazena SVG arbitrário.
- Acesso exclusivo a funcionários. Não possui aplicativo de cliente, cadastro comercial de clientes, pedidos externos, entrega, produção, estoque, fechamento de caixa, contas a pagar/receber, emissão de NF-e/NFC-e/NFS-e ou cálculo tributário. Os documentos e totais são gerenciais, não fiscais.

## Código comum, implantação por cliente

A primeira versão prevê um serviço ERPBack + um ERPFront e uma base exclusiva por cliente. Compartilhar o código permite atualizar as instalações sem forks de personalização. O schema conserva company_id, chaves compostas e filtros por empresa; os testes verificam isolamento. Não existe cadastro público de empresas nem painel de assinatura SaaS nesta versão.

**Plano comercial x configuração operacional:** LICENSE_MODULES, definido pelo operador no Render, libera DASHBOARD e/ou AUDIT. O gerente só pode ativar/desativar a consulta desses módulos em seu painel. A API verifica ambas as condições. O registro da auditoria continua mesmo quando o menu de consulta é desativado. Catálogo, vendas, equipe, frentes e identidade visual são a base obrigatória.

## Desenvolvimento

Node 24 e PostgreSQL 17. Nunca conectar esta versão ao banco da Bonamassa.

```
npm ci
# Copie .env.example para .env e configure um banco novo.
npm run db:migrate
npm run db:seed
npm run dev
```

API em http://localhost:3001/v1. O seed exige SEED_MANAGER_EMAIL e senha de 12–128 caracteres. Reexecução preserva usuários, senhas, catálogo, vendas e configurações existentes. O seed não redefine uma senha de gerente existente; use o fluxo de recuperação.

## Render e Neon

Crie um Web Service Node, branch main. Use banco PostgreSQL novo para este produto/cliente; não reaproveite Bonamassa.

| Campo                 | Valor                                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| Build Command         | npm ci && npm run build                                                         |
| Start Command         | npm run start:deploy                                                            |
| Health Check Path     | /v1/health                                                                      |
| NODE_VERSION          | 24                                                                              |
| NODE_ENV              | production                                                                      |
| DATABASE_URL          | Conexão do banco novo, senha codificada na URL, TLS sslmode=verify-full         |
| CORS_ORIGINS          | URL exata do ERPFront, sem barra final                                          |
| PANEL_URL             | URL exata do ERPFront, sem barra final                                          |
| LICENSE_MODULES       | DASHBOARD,AUDIT (ou apenas os módulos contratados; vazio libera somente a base) |
| SEED_COMPANY_SLUG     | Identificador único, por exemplo padaria-exemplo                                |
| SEED_COMPANY_NAME     | Nome inicial do cliente                                                         |
| SEED_MANAGER_EMAIL    | E-mail do primeiro gerente                                                      |
| SEED_MANAGER_PASSWORD | Senha inicial exclusiva, 12–128 caracteres                                      |

start:deploy aplica migrations pendentes com lock e checksum e executa o seed idempotente antes de iniciar. Alterar SQL de migration já aplicada é recusado. Credenciais ficam no Render, não precisam de arquivo .env no servidor. render.yaml fornece um Blueprint de teste, plano free; dimensionamento e backups precisam de revisão antes de produção comercial.

Para convites e recuperação, configure EMAIL_API_KEY (Resend) e EMAIL_FROM com remetente autorizado. Sem e-mail configurado, vendas/login funcionam e convites/recuperação retornam erro explícito. O primeiro gerente usa a senha inicial do seed. Convites expiram em 24h; recuperação em 30min; tokens de uso único ficam como hash, no fragmento do link enviado, nunca na resposta de cadastro. Reenvio invalida links anteriores. Falha de envio deixa o usuário pendente e informa o gerente.

## Segurança e rastreabilidade

- Senhas scrypt N=32768/r=8/p=3, salt aleatório. Sessões Bearer revogáveis, hash no banco, prazo absoluto de 12h. O frontend guarda o token somente em cookie criptografado HttpOnly, vinculado à origem API e empresa.
- Limites persistentes de tentativas; usuário bloqueado ou senha redefinida perde acesso. Mutações revalidam sessão sob lock da empresa.
- Idempotency-Key UUID em criação e cancelamento de venda. Mesma chave/conteúdo retorna o resultado anterior; conteúdo diferente é conflito. Retentativas simultâneas não duplicam venda.
- Limites iniciais: 2.000 produtos, 100 usuários, 100 itens/venda, 8 recebimentos/venda e R$ 1.000.000 por venda. Histórico e auditoria: 50 linhas/página, período máximo 93 dias. Não há venda offline.
- Auditoria de company, app_user, product, sale, sale_item, payment e invitation: tabela/registro, operação, antes/depois, campos, usuário, função, conta compartilhada, requestId, origem HTTP/SQL e usuário PostgreSQL. Hashes, e-mails e logo são redigidos. Contas compartilhadas identificam o setor, não a pessoa. Não é log integral de SELECT nem auditoria de sessão.
- Trilha rejeita UPDATE/DELETE/TRUNCATE; itens/pagamentos históricos não podem ser alterados/excluídos. O proprietário PostgreSQL continua capaz de administrar objetos, portanto não equivale a trilha criptográfica inviolável.
- /v1/health informa versão/commit e saúde do processo; não executa consulta a cada sondagem. Logs de erro não imprimem URLs ou senhas.
- Há expiração lógica dos tokens e sessões, mas a limpeza periódica e a política de retenção/backup devem ser configuradas na operação; não são jobs ativos nesta primeira versão.

## Contrato de rotas

Públicas: GET /v1/health, GET /v1/branding/:slug, GET /v1/branding/:slug/logo, POST /v1/sessions, POST /v1/access/reset, POST /v1/access/complete.

Autenticadas: GET /v1/me, POST /v1/logout, GET/POST /v1/products, PATCH /v1/products/:id, GET/POST /v1/sales, GET /v1/sales/:id, POST /v1/sales/:id/cancel, GET /v1/dashboard, GET /v1/audit, GET/POST /v1/users, PATCH /v1/users/:id, POST /v1/users/:id/invite, PATCH /v1/settings, POST /v1/logo.

Rotas de gestão exigem MANAGER; CASHIER consulta catálogo/histórico e registra vendas sem desconto. Os campos esperados estão nos schemas de src/core.mjs e src/service.mjs. Dados desconhecidos nas mutações são rejeitados.

## Validação

npm run build, npm test e npm run test:integration. Integração requer TEST_DATABASE_URL com database exatamente erp_test, PostgreSQL descartável já migrado. Nunca usar base real. GitHub Actions usa PostgreSQL 17, aplica migrations duas vezes e verifica pesos, preços, idempotência concorrente, isolamento, perfis, módulos, cancelamento, recuperação, revogação e auditoria.
