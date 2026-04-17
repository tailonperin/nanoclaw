---
name: review-mr
description: Analisa Merge Requests do GitLab focando em segurança, exposição de credenciais e desvios de padrão de código. Use quando o usuário pedir para revisar MRs ou verificar segurança de mudanças.
---

# /review-mr — Análise de Merge Requests

Analisa MRs do GitLab com foco em três pontos: segurança, credenciais expostas e padrão de código.

## Uso

```
/review-mr <project_path>            → analisa todos os MRs abertos
/review-mr <project_path> !<número>  → analisa um MR específico
```

---

## Passo 1 — Obter o MR

Se um MR específico foi indicado, use `mcp__gitlab__gitlab_get_mr` diretamente.

Se nenhum MR foi indicado, use `mcp__gitlab__gitlab_list_mrs` com `state: "opened"`. Se forem ≤ 3, analisa todos. Se forem mais, lista e pergunta quais analisar.

---

## Passo 2 — Coletar contexto

Para cada arquivo modificado no diff:

1. **Leia o arquivo completo** via `mcp__gitlab__gitlab_read_file` na target_branch para entender o contexto antes das mudanças.

2. **Se o diff tocar um job/worker/task/cron** — identifique outro arquivo do mesmo tipo no repositório e leia-o como referência de padrão. Use `mcp__gitlab__gitlab_read_file` para buscar um arquivo similar (mesmo sufixo, mesma pasta).

Limite a 6 arquivos de contexto por MR.

---

## Passo 3 — Análise

Avalie apenas estas três categorias:

### 1. Segurança
- Rotas sem autenticação/autorização onde deveria ter
- Validação de input ausente em endpoints públicos
- Permissões elevadas sem justificativa
- Dados sensíveis retornados desnecessariamente

### 2. Credenciais expostas
- Secrets, tokens, senhas ou chaves hardcoded
- Dados de conexão (hosts, portas, usuários) hardcoded que deveriam ser env vars
- Logs que imprimem valores sensíveis

### 3. Padrão de código
- **Se for job/worker/task:** compare com o arquivo de referência lido no Passo 2. Aponte diferenças estruturais relevantes (tratamento de erro, logging, retry, idempotência).
- **Demais arquivos:** aponte apenas desvios claros de padrão que já existem no projeto (nomenclatura, estrutura de módulo, forma de injeção de dependência).

Ignore: estilo, formatação, cobertura de testes, sugestões de refactor, melhorias de performance — a menos que sejam críticas.

---

## Passo 4 — Relatório

Formato curto, direto. Envie via `mcp__nanoclaw__send_message`:

```
🔍 *!{iid} — {título}*
_{autor} | {N} arquivos_

🔴 *Segurança*
• [arquivo] problema encontrado

🔴 *Credenciais*
• [arquivo] problema encontrado

🟡 *Padrão*
• [arquivo] diferença em relação ao padrão (referência: outro-job.ts)

✅ Nenhum problema encontrado.
```

Use apenas as seções que tiverem algo a reportar. Se não encontrar nada, responda só com `✅ Nenhum problema encontrado.`

Seja direto — uma linha por problema, sem explicações longas.

---

## Sem acesso ao GitLab

Se as tools `mcp__gitlab__*` não existirem:

> Não tenho acesso ao GitLab configurado. Peça ao administrador para configurar a integração.
