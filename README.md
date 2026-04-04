# Agent CLI

Loop autônomo que usa ferramentas de IA (amp ou claude) para implementar user stories definidas em um PRD (`prd.json`). Ele executa iterações até que todas as stories estejam completas ou o limite de iterações seja atingido.

## Como funciona

1. Você cria um arquivo `prd.json` no diretório do seu projeto com as user stories a implementar
2. O Agent CLI lê o PRD, encontra a story de maior prioridade com `passes: false`
3. Ele invoca a ferramenta de IA (amp ou claude), alimentando-a com as instruções do `CLAUDE.md` (ou `prompt.md`)
4. A ferramenta de IA implementa a story e, ao concluir, marca `passes: true` no PRD
5. O loop repete para a próxima story
6. Quando todas as stories estão completas, a ferramenta de IA emite `<promise>COMPLETE</promise>` e o loop encerra

## Instalação

```bash
npm install
npm run build
npm link  # Opcional: para usar `agent-cli` globalmente
```

## Uso básico

```bash
# No diretório do seu projeto (onde está o prd.json)
agent-cli

# Especificar ferramenta e máximo de iterações
agent-cli --tool claude 15

# Apontar para outro diretório
agent-cli --directory /caminho/para/projeto --tool amp 10
```

| Opção | Descrição | Padrão |
|-------|-----------|--------|
| `[max_iterations]` | Número máximo de iterações | `10` |
| `--tool <amp\|claude>` | Ferramenta de IA a usar | `amp` |
| `--directory <path>` | Diretório de trabalho | Diretório atual |
| `--dry-run` | Simula o loop sem spawnar ferramentas externas | `false` |

## Usando em outro projeto

Para usar o Agent CLI em um projeto seu, você precisa de **dois arquivos** no diretório do projeto:

### 1. `prd.json` — Obrigatório

Define as stories que a IA deve implementar:

```json
{
  "project": "MeuProjeto",
  "branchName": "feature/minha-feature",
  "description": "Descrição da feature",
  "userStories": [
    {
      "id": "US-001",
      "title": "Criar endpoint de login",
      "description": "Implementar POST /api/login com validação",
      "acceptanceCriteria": [
        "Endpoint responde 200 com token válido",
        "Retorna 401 para credenciais inválidas"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-002",
      "title": "Adicionar testes de integração",
      "description": "Testes para o endpoint de login",
      "acceptanceCriteria": [
        "Testes cobrem sucesso e falha"
      ],
      "priority": 2,
      "passes": false,
      "notes": ""
    }
  ]
}
```

**Campos:**
- `priority`: número menor = prioridade maior (executa primeiro)
- `passes`: `false` = pendente, `true` = concluída
- `branchName`: ao mudar, o Agent CLI arquiva a execução anterior automaticamente

### 2. `CLAUDE.md` ou `prompt.md` — Obrigatório

Instruções que a ferramenta de IA vai receber. Use `CLAUDE.md` para claude, `prompt.md` para amp.

O arquivo deve instruir a IA a:
1. Ler o `prd.json`
2. Pegar a story de maior prioridade com `passes: false`
3. Implementar essa story
4. Se os testes passarem, atualizar `passes: true` no PRD
5. Se todas as stories estiverem completas, emitir `<promise>COMPLETE</promise>`

Exemplo mínimo de `CLAUDE.md`:

```markdown
Você é um agente de desenvolvimento.

1. Leia prd.json
2. Pegue a story com maior prioridade onde passes: false
3. Implemente essa story
4. Se funcionar, atualize passes: true no prd.json
5. Se todas as stories estão completas, responda: <promise>COMPLETE</promise>
```

### Exemplo completo

```bash
# No seu projeto
cd /meu-projeto

# Garantir que os arquivos existem
ls prd.json CLAUDE.md

# Executar com claude
agent-cli --tool claude 20

# Ou executar com amp
agent-cli --tool amp 10

# Simular o loop sem spawnar ferramentas (para testar)
agent-cli --dry-run 5
```

## Arquivamento automático

Quando o `branchName` no PRD muda entre execuções, o Agent CLI arquiva o estado anterior em:

```
archive/YYYY-MM-DD-nome-da-feature/
  ├── prd.json
  └── progress.log
```

## Encerramento

O loop encerra quando:
- Todas as stories têm `passes: true`, OU
- O número máximo de iterações é atingido

## Desenvolvimento

Este projeto usa **tsgo** (`@typescript/native-preview`) — o compilador TypeScript nativo em Go, que é significativamente mais rápido que o `tsc` tradicional.

```bash
npm run build      # Compilar com tsgo (recomendado)
npm run build:old  # Compilar com tsc (fallback)
npm run dev        # Compilar com tsgo + executar
npm run watch      # Compilar em modo watch com tsc
```

Requer Node >= 20.
