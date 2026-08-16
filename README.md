# leads

Pipeline para achar e qualificar pequenos negócios brasileiros como clientes de
**sites/landing pages** e **automação de WhatsApp**.

O caminho é: dados abertos da Receita Federal → filtro determinístico → verificação do
site do próprio negócio → pontuação por LLM → fila de revisão manual.

**Custo: R$ 0.** Receita Federal, IBGE e PageSpeed Insights são gratuitos; os modelos
padrão do OpenRouter também. A API do Google Places fica **desligada por padrão** — ela é
cara e, pelos termos do Google, os dados dela não podem ser armazenados (veja
[Limites](#limites-que-valem-conhecer)).

---

## Começando

```bash
npm install
cp .env.example .env          # preencha OPEN_ROUTER_API_KEY e SENDER_NAME
npm run db:up                 # sobe o Postgres no Docker
npm run db:migrate            # cria o schema
npm run ibge                  # 5.571 municípios + população
```

Carregue os dados da Receita. O filtro por CNAE é o que mantém o banco pequeno:

```bash
# veja o tamanho do download antes de baixar
npm run load -- --dry-run

# restaurantes, salões, dentistas, oficinas, academias, mercados — 1/10 da base
npm run load -- --cnae 5611,9602,8630,4520,9313,4712 --parts 0
```

Depois, o ciclo normal:

```bash
npm run enrich -- --limit 500     # visita o site de cada lead (grátis)
npm run score  -- --limit 200     # pontua com rubrica ancorada
npm run web                       # dashboard em http://localhost:3100
```

## Comandos

| Comando | O que faz |
|---|---|
| `npm run db:up` / `db:down` / `db:reset` | Postgres local via Docker Compose |
| `npm run db:migrate` | aplica as migrations |
| `npm run db:psql` | abre o psql no banco |
| `npm run ibge` | carrega municípios e população do IBGE |
| `npm run cnaes` | carrega a tabela oficial de CNAEs (~1.359 códigos, 22 KB) |
| `npm run load` | baixa e carrega os dados abertos da Receita |
| `npm run enrich` | busca e analisa o site de cada lead |
| `npm run score` | pontua os leads com LLM |
| `npm run queue` | fila de revisão no terminal |
| `npm run export -- leads.csv` | exporta para CSV |
| `npm start -- stats` | estado do pipeline e gasto com API do Google |
| `npm start -- models` | lista os modelos gratuitos do OpenRouter agora |
| `npm run web` | dashboard Next.js |

### Flags que importam

```bash
npm run load -- --uf SP --cnae 5611 --parts 0,1 --dry-run --keep-files
npm run enrich -- --limit 1000 --concurrency 20 --psi --recheck
npm run score -- --limit 500 --batch 10 --rescore
npm run queue -- --tier hot --limit 40
```

---

## Como funciona

```
Receita Federal (bulk, grátis)  ─┐
IBGE municípios + população     ─┼─▶  Postgres  ◀── o banco de dados
                                 │       │
                                 │       ▼
                                 │   filtro determinístico (sem LLM)
                                 │       │  ativa · celular · não é rede
                                 │       ▼
                                 │   enriquecimento: nosso próprio GET no site deles
                                 │       │  sem site · morto · linktree · sem viewport
                                 │       ▼
                                 │   pontuação LLM: web_fit + chatbot_fit + gancho
                                 │       │
                                 └──────▶ fila → WhatsApp manual → resultados
```

### O filtro determinístico vem antes do LLM

O que `if` responde de graça, o modelo não precisa responder. O pipeline descarta 50–70%
das linhas com regras (situação cadastral, número de celular, rede/franquia, supressão)
**antes** de gastar um token. É o que resolve o problema de "lead ruim demais".

### O enriquecimento é feito com requisições nossas

Cada site é buscado por nós, e as observações são nossas — não do Google. Sinais coletados:
sem site, site morto/404, "site" que é só Linktree/Instagram, construtor grátis
(`wixsite.com`, `negocio.site`), sem HTTPS, sem `meta viewport`, sem caminho de contato,
link `wa.me` presente, plataforma, ano no rodapé e, opcionalmente, PageSpeed.

O segmento menos disputado não é "não tem site" — todo mundo aborda esses. É **tem site,
mas é um Wix morto / Linktree**, com movimento real. Filtre por `site=dead` ou `site=hub`
no dashboard.

### A pontuação nunca inventa um número

Duas notas independentes de 1 a 5 (`web_fit`, `chatbot_fit`), com rubrica ancorada,
`justification` antes da nota no schema, campo `confidence` e saída `cannot_determine`.
Quando a chamada falha, o lead fica com **score `NULL` e o erro registrado** — nunca um 5
falso que se confunde com um 5 de verdade.

O campo mais valioso não é a nota, é o **`hook`**: uma frase concreta sobre aquele negócio
específico, que é o que separa 10% de resposta de 4%.

---

## O que os dados realmente mostram

Números medidos numa carga real (6 CNAEs, 1 de 10 partes da base, snapshot 2026-07-12):

| Métrica | Valor |
|---|---|
| leads carregados | 1.661.735 |
| com telefone | 98,4% |
| **com celular (contatável no WhatsApp)** | **70,3% — 1.168.060** |
| com e-mail | 90,7% |
| municípios resolvidos | 99,99% |
| municípios representados | 5.274 de 5.571 |
| MEI | 66,5% |
| abertos nos últimos 2 anos | 428.667 |

### O nono dígito — a diferença entre isso funcionar ou não

A Receita guarda os telefones no **formato antigo de 8 dígitos**, anterior à migração do
nono dígito. A `libphonenumber` corretamente rejeita um celular brasileiro de 8 dígitos
como inválido, então, sem tratamento, **todos os celulares viram "fixo"**: a taxa medida
foi de 2,5%. Reconstruindo o número (8 dígitos começando em 6–9 → prefixa "9"), a taxa
real é **70,3%**. É a diferença entre 42 mil e 1,17 milhão de leads contatáveis.
Implementado em [`src/phone.ts`](./src/phone.ts).

### Celular é ordenação, não filtro

Durante um tempo o pipeline inteiro filtrava por `is_mobile`. Fazia sentido enquanto o alvo
era micronegócio: o telefone que o dono registra na Receita **é** o celular dele. Mas
**instituições registram telefone fixo** — escola, faculdade, curso. Com o filtro antigo,
uma carga de CNAE 85 ficaria quase toda invisível para `enrich`, `score`, `queue` e para
todas as telas do painel.

A classificação está certa; o erro era usá-la como porta. Hoje o filtro é
`phone_e164 IS NOT NULL` e `is_mobile` virou **critério de ordenação** mais um filtro
opcional (`?canal=mobile|landline`). Só isso liberou **443.515 leads** que já estavam no
banco e nunca apareciam.

Fixo é *talvez*, não *não*: muita escola atende WhatsApp Business em linha fixa. A fila
mostra o canal em cada linha e avisa antes de você clicar no `wa.me`.

### O que a Receita NÃO dá

**Não existe campo de site.** Isso significa que os sinais que realmente separam um bom
lead de um ruim — site morto, Linktree, não responsivo — não estão nos dados abertos.
Medições:

- e-mail em domínio próprio (único sinal de site grátis): **1,6% dos leads**
- e o resto é gmail/hotmail, que não diz nada

Por isso o `score` devolve quase tudo com `confidence: low` até você rodar `places`.
O sistema é honesto sobre isso: ele **não** afirma "não tem site" quando só não encontrou
um. O gancho gerado pergunta em vez de afirmar.

**A conclusão prática:** a Receita entrega volume e contato de graça; o sinal de qualidade
vem do `npm run places`, cuja cota grátis (1.000 detalhes/mês) casa quase exatamente com
a capacidade de um envio manual de 40/dia (~800/mês).

### Modelos gratuitos têm limites reais

20 req/min, 50 req/dia (1.000/dia se a conta já comprou ≥ 10 créditos), e às vezes o
provedor devolve 429 ou JSON malformado. O cliente tenta de novo e, se não conseguir,
grava `score = NULL` com o erro — **nunca** um 5 inventado. Rode `npm start -- models`
para ver a lista atual.

## Limites que valem conhecer

**WhatsApp.** A Política de Mensagens Comerciais da Meta exige que a pessoa tenha te dado o
número *e* dado opt-in. Um número vindo da Receita ou do Google Maps não atende a nenhum
dos dois. Não existe configuração — API ou app pessoal — em que abordagem fria seja
compatível com a política. O que dá para controlar é **a taxa de bloqueio e denúncia**, que
é o que de fato derruba número. Por isso a ferramenta não envia nada, limita 40/dia por
padrão, exige salvar o contato antes, permite no máximo 2 toques e mantém lista de
supressão permanente.

**LGPD.** Dado de pessoa jurídica em geral está fora da LGPD, mas **MEI e empresário
individual são pessoas naturais** — e a maioria dos micronegócios usa o celular pessoal do
dono. Assuma que a LGPD se aplica. A base legal viável é legítimo interesse (Art. 7º, IX),
que exige: LIA documentado (veja [`LIA.md`](./LIA.md)), procedência por lead (as colunas
`source`, `source_url`, `collected_at` existem para isso), identificação do remetente na
primeira linha, opt-out oferecido já na primeira mensagem e honrado para sempre.

**Google Places.** Os termos permitem armazenar **apenas o `place_id`** por tempo
indeterminado; lat/lng no máximo 30 dias; nome, telefone, endereço, nota e avaliações **não
podem ser armazenados**. Por isso o banco é construído sobre a Receita Federal, e o schema
guarda só `google_place_id`. Além disso o nível gratuito hoje é de **1.000 chamadas/mês**
nos SKUs Enterprise — que é o nível exigido por telefone e site.

**Receita Federal.** Não existe API oficial de consulta: são arquivos mensais em massa
(usamos o espelho da Casa dos Dados, servido por CDN) e uma página com captcha. APIs de
terceiros como a BrasilAPI servem para conferir **um** CNPJ, não para carga.

---

## Dashboard

`npm run web` → <http://localhost:3100>

Tudo é tabela — filtros, ordenação e paginação vivem na URL, então qualquer visão é
linkável e o servidor faz o trabalho (importa quando a tabela tem milhões de linhas).

| Rota | O quê |
|---|---|
| `/` | tabela principal, com barra de filtros e atalhos |
| `/discover` | quantas empresas existem num segmento e quantas dá para contatar |
| `/lead/[cnpj]` | ficha completa: cadastro, sinais do site, pontuação, procedência |
| `/queue` | fila do dia, com limite diário e ações inline |
| `/coverage` | onde há leads e onde o enriquecimento ainda não chegou |
| `/outreach` | enviados/respostas por semana |

O dashboard registra que uma mensagem **foi** enviada. Ele nunca envia.

### Rodar o pipeline pelo navegador

A barra abaixo do menu tem os três passos do dia a dia:

```
[Enriquecer sites 500] [Pontuar leads 200] [Buscar no Google 25 · 978 restantes]   histórico ▾
```

Clicar dispara **o mesmo CLI** que você roda no terminal — não existe uma segunda
implementação. Enquanto roda, a barra expande e mostra a saída real do comando, o tempo
decorrido e um botão de cancelar. Quando termina, as tabelas se atualizam sozinhas.

- **Um job por vez.** Garantido por um índice único parcial no Postgres, não por
  JavaScript — dois cliques rápidos não conseguem iniciar dois processos.
- **`load` e `ibge` não estão aqui** de propósito: 2GB+ e ~30 min não cabem numa aba.
  `queue` também não, porque é interativo e travaria.
- **`--allow-paid` não é exposto.** É a única flag que gasta dinheiro de verdade.
- O botão do Google mostra a cota grátis restante e se desabilita no zero. Quem realmente
  impede o gasto continua sendo `src/budget.ts`.
- `histórico ▾` lista os últimos 10 runs com status e duração.

⚠️ **Não exponha essa porta na rede.** O dashboard não tem autenticação e inicia processos
no seu computador. Ele foi feito para `localhost`.

---

## Estrutura

```
migrations/001_init.sql   schema
src/db.ts                 pool do Postgres
src/migrate.ts            runner de migrations
src/ibge.ts               municípios + população
src/receita.ts            download e carga dos dados abertos
src/enrich.ts             verificação do site + PageSpeed
src/llm.ts                cliente OpenRouter (modelos gratuitos por padrão)
src/score.ts              rubrica e pontuação
src/draft.ts              redação da mensagem
src/queue.ts              fila no terminal
src/budget.ts             trava de gasto da API do Google
src/phone.ts              classificação de telefone (celular vs fixo)
src/csv.ts                exportação
migrations/               schema (004 = tabela de jobs)
web/lib/jobs.ts           dispara o CLI e captura a saída (allowlist)
web/components/JobPanel.tsx  a barra de ações (único client component)
web/                      dashboard Next.js
```
