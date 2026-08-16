# LIA — Avaliação de Legítimo Interesse

Documento exigido pelo Art. 10 da LGPD quando o tratamento se apoia em legítimo interesse
(Art. 7º, IX). Referência: ANPD, *Guia Orientativo — Legítimo Interesse*.

> **Isto não é parecer jurídico.** É o registro interno da avaliação feita antes de operar
> a ferramenta. Se a operação crescer, procure advogado especializado em proteção de dados.

**Controlador:** _(preencher: nome, CNPJ, e-mail de contato)_
**Encarregado (DPO):** _(preencher — pode ser o próprio titular em operação individual)_
**Data desta avaliação:** _(preencher)_
**Revisão prevista:** a cada 12 meses ou a qualquer mudança relevante na operação.

---

## 1. Finalidade

**A finalidade é por oferta, não global.** Legítimo interesse é específico à finalidade
declarada, então uma ferramenta que hoje procura clientes para um produto e amanhã para
outro não tem *uma* finalidade — tem uma por campanha.

Cada oferta declara a sua no campo `offer_specs.finalidade`, obrigatório no schema e
obrigatório no formulário que cria a oferta. `npm start -- offer show <id>` imprime a
finalidade junto da rubrica, e cada pontuação grava `(offer_id, offer_version,
prompt_sha)` — dá para reconstruir exatamente sob qual finalidade e sob qual critério um
lead foi avaliado.

Exemplo (a oferta original, `site-chatbot`): *identificar micro e pequenas empresas
brasileiras cujo perfil indique necessidade de (a) site/landing page ou (b) automação de
atendimento por WhatsApp, para oferta comercial direta, individual e de baixo volume.*

Qualquer finalidade declarada precisa continuar sendo **comercial legítima e específica**,
e o que segue vale para todas: não há criação de perfil comportamental, não há decisão
automatizada com efeito jurídico sobre o titular, não há enriquecimento com dados sensíveis
(Art. 5º, II) e não há revenda ou compartilhamento da base com terceiros.

**Limite explícito:** uma oferta cuja finalidade não passe nesse teste não pode ser operada
só porque o software aceita cadastrá-la. O campo obriga a escrever a finalidade; não a
torna legítima.

## 2. Dados tratados e origem

| Dado | Origem | Natureza |
|---|---|---|
| CNPJ, razão social, nome fantasia, CNAE, porte, capital social, natureza jurídica, data de início, situação cadastral, endereço | Dados Abertos da Receita Federal | público, cadastral |
| DDD + telefone, e-mail | Dados Abertos da Receita Federal | público, **pode ser pessoal** (ver §4) |
| Sinais técnicos do site da empresa (status HTTP, HTTPS, viewport, plataforma, presença de link de contato) | requisição HTTP nossa ao site público da empresa | técnico, não pessoal |
| `place_id` do Google | Google Places API (opcional, desligado por padrão) | identificador técnico |

**Minimização.** Não coletamos quadro societário (`SOCIOS`), CPF, faixa etária, nem dados
de pessoas físicas não relacionadas à atividade empresarial. O filtro por CNAE e situação
cadastral é aplicado **durante o streaming**, antes da gravação: linhas fora do escopo
nunca chegam ao banco.

**Procedência.** Cada registro grava `source`, `source_url` e `collected_at`. É a resposta
a "de onde você tirou esse número?" numa eventual fiscalização da ANPD.

## 3. Necessidade

O tratamento é necessário porque não há meio menos invasivo de identificar quais empresas
têm a necessidade específica que o produto resolve. Os dados usados são o mínimo para:

- determinar se a empresa está **ativa** (situação cadastral),
- determinar se é do **segmento** atendido (CNAE),
- determinar se **pode contratar** (natureza jurídica — administração pública só compra por
  licitação, então contatá-la seria contato sem finalidade útil),
- determinar se há **necessidade real** (verificação do próprio site da empresa),
- permitir o **contato** (telefone comercial divulgado publicamente).

Não é usado nenhum dado que não participe diretamente de uma dessas cinco decisões.

**Sobre a verificação do site.** Na oferta original, o site *era* a evidência da carência
("o site está fora do ar"). Para uma oferta em que isso não vale — por exemplo um produto
pedagógico vendido a escolas —, a mesma verificação continua necessária, mas por outro
motivo: é o que estabelece porte, segmento e se a organização já compra software, além de
ser a origem do fato concreto citado na abordagem. Uma oferta que não precise de nenhum
desses sinais deve declarar `siteSignals: "none"` e o site não é buscado.

## 4. Balanceamento — expectativa legítima e direitos do titular

**O ponto crítico desta avaliação.** Dados de pessoa jurídica estão, em regra, fora do
alcance da LGPD. Porém **MEI e empresário individual não têm personalidade jurídica
separada da pessoa natural**, e na prática a maioria dos micronegócios brasileiros registra
o celular pessoal do dono como telefone da empresa.

**Conclusão adotada: presumimos que a LGPD se aplica.** Não nos apoiamos no argumento de
que "é dado de PJ". Consequências operacionais:

- O campo `opcao_mei` fica visível no painel, e a preferência é por alvos não-MEI quando a
  natureza jurídica permite distinguir.
- O tratamento é dimensionado para volume baixo e contato individual, não para disparo.

**Expectativa do titular.** O número foi divulgado publicamente pela própria empresa, em
cadastro oficial, como canal comercial. Contato comercial B2B, identificado, pertinente ao
ramo de atividade e com saída imediata está dentro do que se espera de um canal comercial
divulgado. O art. 7º, §3º exige respeito à finalidade e à boa-fé da divulgação original —
por isso o contato é **sempre relacionado à atividade da empresa** e nunca pessoal.

**Riscos identificados e mitigações:**

| Risco | Mitigação implementada |
|---|---|
| Incômodo por contato não solicitado | limite de 40 mensagens/dia; máximo 2 toques por lead; carência de 90 dias |
| Contato repetido com a mesma pessoa | deduplicação por telefone (E.164), não por CNPJ — um dono com vários CNPJs é contatado uma vez só |
| Titular não consegue se opor | opt-out oferecido **na primeira mensagem**; tabela `suppression` consultada antes de todo envio, permanente e por telefone |
| Retenção indefinida | expurgo de prospects sem interação após 12–24 meses |
| Mensagem enganosa ou sem identificação | remetente identificado na primeira linha (`SENDER_NAME`, `SENDER_COMPANY`, `SENDER_CNPJ`); o rascunho é proibido de prometer resultado |
| Vazamento da base | banco local, sem exposição em rede; `data/`, `*.csv` e `pgdata/` no `.gitignore` |

## 5. Salvaguardas técnicas (implementadas no código)

- `suppression` — chave é o telefone; consultada em toda seleção de fila. Permanente.
- `outreach.touches` e `followup_at` — limitam a 2 toques.
- `DAILY_SEND_CAP` (padrão 40) — limite diário aplicado no CLI e no painel.
- A ferramenta **não envia mensagens**. Só registra o que a pessoa fez manualmente.
- `source` / `source_url` / `collected_at` — procedência por registro.
- `outreach_one_per_phone_idx` — índice único no telefone. A regra "uma pessoa, um
  contato" deixou de ser convenção e passou a ser restrição do banco: com várias ofertas
  cadastradas, uma segunda campanha **não consegue** inserir contato para um número que
  já foi abordado. O erro 23505 é a garantia, não a checagem no código.
- Oferta em pré-venda (`stage: "presell"`) muda o prompt do rascunho: proíbe presente
  ("temos", "nosso app faz"), proíbe citar cliente, número ou resultado, proíbe oferecer
  teste, plano ou preço, e obriga a dizer que o produto ainda está sendo construído. O
  validador recusa a oferta se os fechos contiverem "contratar", "assinar", "plano",
  "desconto" ou "preço". Vender algo que não existe seria publicidade enganosa (CDC
  Art. 37) antes de ser problema de LGPD.
- `offer_specs.finalidade` — finalidade declarada por oferta, obrigatória (ver §1).
- `OPENROUTER_DAILY_REQUESTS` — teto diário de chamadas ao modelo, conferido **antes** da
  primeira requisição.
- Dados do Google Places não são persistidos além do `place_id`, conforme os termos.

## 6. Direitos do titular (Art. 18)

Canal de atendimento: _(preencher e-mail)_. Prazo de resposta: 15 dias.

| Direito | Como é atendido |
|---|---|
| Confirmação e acesso | consulta por telefone ou CNPJ no banco; resposta com os campos e a origem |
| Correção | atualização no registro, ou recarga do dado público atualizado |
| Anonimização / eliminação | `DELETE FROM leads WHERE cnpj = ...` (cascata para as demais tabelas) |
| Oposição | inclusão em `suppression`, que bloqueia qualquer contato futuro |
| Informação sobre compartilhamento | não há compartilhamento com terceiros |

**Atenção:** ao atender um pedido de eliminação, mantenha o telefone em `suppression` — é o
que impede que o mesmo número volte a entrar na base numa recarga futura. Essa retenção
mínima é, ela própria, uma medida de proteção do titular.

## 7. Conclusão

O tratamento é considerado **apoiável em legítimo interesse**, condicionado à manutenção
integral das salvaguardas do §5 — em especial o opt-out na primeira mensagem, a supressão
permanente por telefone e o limite de volume.

Se qualquer uma dessas salvaguardas for removida (por exemplo, automatizar o envio ou
elevar o volume), **esta avaliação deixa de valer** e precisa ser refeita.

---

### Nota separada: política do WhatsApp ≠ LGPD

A LGPD e a Política de Mensagens Comerciais da Meta são coisas distintas. Mesmo que o
tratamento seja lícito sob a LGPD, a política da Meta exige opt-in prévio do destinatário —
o que uma base pública não fornece. Operar abordagem fria no WhatsApp é uma **decisão
comercial de risco de plataforma** (bloqueio ou banimento do número), assumida
conscientemente, e não é resolvida por este documento.
