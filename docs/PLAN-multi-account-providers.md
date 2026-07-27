# Plano: múltiplas contas por provider

## Objetivo

Permitir que o BrightCode faça login e use várias contas dentro do mesmo provider, com seleção manual por sessão e, posteriormente, fallback/rotação automática. A conta atualmente configurada deve continuar funcionando como `default` após a migração.

## Diagnóstico atual

- O armazenamento de autenticação usa `providerId` como chave e aceita apenas uma credencial por provider.
- O `ProviderRegistry` resolve uma única credencial por provider/modelo.
- A interface de providers mostra apenas uma conta por provider.
- A detecção de CLIs colapsa múltiplas detecções do mesmo provider.
- As sessões não persistem um `accountId`.
- Tokens ainda precisam ser migrados para armazenamento seguro do sistema operacional.
- A documentação e o bootstrap de providers ainda não estão totalmente alinhados (por exemplo, MiniMax/PayPerQ).
- Ainda não há quota por conta, round-robin, failover ou métricas de uso por credencial.

## Estado da implementação auditado

As fases 1–3 já foram implementadas em grande parte, mas ainda têm pendências de segurança e validação:

| Fase | Estado | Observação |
|---|---|---|
| 1 — núcleo de contas | Parcial | `AccountStore`, migração e IPC existem; os segredos ainda ficam em JSON/localStorage sem keychain seguro. |
| 2 — interface de contas | Quase concluída | A UI de contas, OAuth, renomear, remover, ativar e hidratação de `activeAccountId` existem. Falta teste real de restart e seleção. |
| 3 — sessões e seleção | Parcial/funcional | `selectedAccountId` é persistido na task e enviado ao streaming. A tela inicial ainda não conecta o seletor de conta ao `ChatInput`. |

No estado atual, `npm run build` passa. `npm run lint` também passa, mas ainda reporta avisos de dependências de hooks e Fast Refresh. A implementação só deve ser marcada como concluída depois da correção da tela inicial, dos testes de persistência e do armazenamento seguro.

### Auditoria específica de Usage/quota

O agente adicionou a fundação de telemetria, mas não a funcionalidade completa de quota:

- [x] Tipos `UsageRecord`, `QuotaSnapshot` e `UsageSummary`.
- [x] Modelo de janelas de quota por conta/modelo (`QuotaWindow`), inspirado no Quota Tracker do 9Router.
- [x] Persistência local/Electron de eventos de uso.
- [x] Registro automático do usage recebido no `message_end`.
- [x] Estimativa de custo usando o catálogo de modelos.
- [x] IPC para ler histórico, resumos e gravar quota.
- [x] Aba visual `Settings > Usage` com cards por provider/conta, tokens, custo, janelas e reset.
- [x] Ações de atualizar e limpar histórico dentro do BrightCode.
- [x] Consulta automática de quota para Codex OAuth, Gemini CLI, Antigravity e MiniMax quando a conta fornece o endpoint oficial.
- [ ] Fetchers específicos para GLM e demais providers.
- [ ] Integração com endpoints de usage/dashboard do 9Router.
- [ ] Atualização automática, cache/TTL e indicação da origem do dado.

O histórico Electron agora usa uma leitura agregada própria para não depender de um `providerId` fictício. A quota automática continua separada: o 9Router consulta APIs/fetchers específicos por provider e mantém várias janelas por conta; não devemos tentar extrair os dados raspando a tela do dashboard.

## Referências analisadas

- [OpenCode — Providers](https://opencode.ai/docs/providers)
- [OpenCode — implementação de autenticação](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/auth/index.ts)
- [Orca — Codex account hot-swap](https://www.onorca.dev/docs/agents/codex-hot-swap)
- [Orca — Claude accounts](https://www.onorca.dev/docs/agents/claude-code)
- [Orca — repositório](https://github.com/stablyai/orca)
- [9Router — arquitetura](https://github.com/decolua/9router/blob/master/docs/ARCHITECTURE.md)
- [9Router — site oficial](https://tunnel.9router.com/)
- [Pi Account Switcher](https://pi.dev/packages/pi-account-switcher)

### Conclusões das referências

- O OpenCode possui vários providers, mas o núcleo atual armazena uma credencial por `providerId`. A autenticação múltipla precisa ser implementada com perfis/aliases ou por uma camada externa.
- O Orca é uma boa referência de UX: detecta perfis locais, permite rotular contas, mostra uso e troca a conta para novas sessões.
- O 9Router é a principal referência de roteamento: suporta múltiplas contas por provider, quota, fallback e round-robin.
- O Pi Account Switcher é uma boa referência para o modelo de dados de contas e comandos de gerenciamento.

> “PNI” foi interpretado como Pi. Se for outro projeto, substituir esta referência após confirmar o nome.

## Modelo de dados proposto

```text
ProviderAccount {
  id: string
  providerId: string
  label: string
  email?: string
  authMethod: api_key | oauth | cli_profile | gateway
  secretRef: string
  cliSource?: string
  profilePath?: string
  enabled: boolean
  expiresAt?: number
  lastUsedAt?: number
  metadata?: object
}

ProviderState {
  providerId: string
  activeAccountId?: string
  strategy: manual | failover | round_robin
}

SessionProvider {
  providerId: string
  accountId?: string
  modelId: string
}
```

Regras importantes:

1. `providerId` identifica o serviço; `accountId` identifica a conta.
2. O segredo nunca deve ser enviado ao React/renderer; a interface recebe apenas label, email e estado.
3. A conta ativa afeta novas requisições. Uma sessão em andamento permanece vinculada à conta selecionada.
4. A conta existente deve ser migrada para `default` sem exigir novo login.

## Plano de execução

### Fase 0 — contratos e inventário

- [ ] Definir a matriz oficial de providers e métodos de autenticação.
- [ ] Confirmar se “PNI” significa Pi.
- [ ] Definir quais CLIs terão importação de múltiplos perfis.
- [ ] Definir política de segurança e expiração de tokens.
- [ ] Verificar licenças antes de reutilizar código externo.

### Fase 1 — núcleo seguro de contas

- [ ] Criar `AccountStore` com `accountId`.
- [ ] Migrar o formato atual `{ providerId: credential }` para uma conta `default` por provider.
- [ ] Atualizar Electron IPC e preload para CRUD de contas.
- [ ] Migrar segredos para Windows Credential Manager/keytar ou equivalente.
- [ ] Manter compatibilidade de leitura com o formato antigo durante a transição.
- [ ] Redigir logs sem tokens, refresh tokens ou headers sensíveis.

### Fase 2 — interface de contas

- [ ] Exibir lista de contas agrupadas por provider.
- [ ] Adicionar “Adicionar conta”.
- [ ] Permitir renomear, ativar, desativar, testar e remover contas.
- [ ] Mostrar a conta selecionada no seletor de modelo.
- [ ] Mostrar estado de autenticação e expiração sem revelar segredos.

### Fase 3 — sessões e seleção

- [ ] Persistir `accountId` na sessão.
- [ ] Permitir fixar uma conta em uma conversa.
- [ ] Permitir trocar a conta para novas mensagens.
- [ ] Garantir que troca global não interrompa uma execução em andamento.
- [ ] Atualizar o `ProviderRegistry` para resolver `(providerId, accountId)`.

### Fase 4 — OAuth e perfis de CLI

- [ ] Listar todas as contas detectadas, sem usar um `Map` que elimine duplicatas.
- [ ] Detectar a conta única da CLI Codex, Claude, Gemini, Antigravity e OpenCode.
- [ ] Importar referências de perfil com segurança.
- [ ] Exibir email/label/projeto quando disponível.
- [ ] Implementar refresh e validação por conta.

#### Regra de CLI versus OAuth

Uma instalação normal de uma CLI representa uma única sessão/conta por vez. Não devemos prometer “várias contas na mesma CLI” quando o formato da CLI não oferece perfis separados. A regra do BrightCode será:

- `cli_detected`: uma conta detectada por CLI/perfil local;
- `oauth`: várias contas do mesmo provider, identificadas por email/conta;
- `api_key`: várias chaves podem ser cadastradas manualmente;
- múltiplas contas de CLI só serão suportadas quando a própria CLI oferecer perfis separados, diretórios isolados ou um mecanismo oficial de troca.

No seletor de contas, contas CLI devem aparecer como uma conta importada, enquanto o botão “Adicionar conta” deve priorizar OAuth/API key. A troca da conta OAuth no BrightCode não deve tentar reescrever a sessão interna da CLI.

#### Antigravity

- [ ] Manter a investigação da detecção e autenticação do Antigravity separada da migração de contas.
- [ ] Validar caminho de credenciais, keyring, formato do token, endpoint Cloud Code e refresh.
- [ ] Não marcar o provider como concluído até um teste real de login, streaming e uso de ferramenta.

### Fase 5 — uso, quota e resiliência

- [ ] Registrar uso e último uso por conta.
- [ ] Detectar `401`, `403`, `429` e falhas temporárias.
- [ ] Implementar fallback manual primeiro.
- [ ] Implementar fallback automático configurável.
- [ ] Adicionar round-robin como opção avançada.
- [ ] Não repetir automaticamente ferramentas de escrita sem verificar idempotência.

#### Aba Usage nos Settings

Criar uma aba `Usage` em Settings para consolidar o estado de todas as contas:

- [x] Cards por provider e conta.
- [x] Modelo usado, requisições, tokens de entrada/saída e custo estimado.
- [x] Quota restante, janela de reset e status de rate limit quando o provider fornecer esses dados.
- [x] Última atualização e origem do dado (`provider`, `CLI`, `9Router` ou `estimado localmente`).
- [ ] Filtros por período, provider, conta e modelo.
- [x] Botão de atualizar manualmente; atualização automática com cache/TTL permanece pendente.
- [x] Estados claros: disponível, expirado, limitado e informação indisponível.
- [ ] Não exibir tokens, refresh tokens ou outras credenciais nessa tela.

#### Como obter os dados

Não existe uma API universal de quota. O BrightCode deve separar duas categorias:

1. **Uso observado:** dados extraídos de cada resposta (`input_tokens`, `output_tokens`, duração, modelo e custo estimado), sempre que o provider enviar essa informação. Caso não envie, registrar apenas a requisição e marcar a estimativa como aproximada.
2. **Quota oficial:** saldo, limite, janela de reset e rate limit obtidos por um endpoint específico do provider, pela CLI correspondente ou por um gateway como o 9Router.

Cada adapter deverá expor, quando possível:

```text
getUsage(account): UsageSnapshot
getQuota(account): QuotaSnapshot | unavailable
```

O snapshot deve ser normalizado para a UI, mas preservar `source`, `collectedAt` e `confidence`. A consulta deve ter timeout, cache e tratamento de expiração para não bloquear o chat.

#### Referência do 9Router

O 9Router combina três mecanismos que devemos considerar:

- extrai e normaliza o uso das respostas no núcleo de streaming;
- persiste histórico local de uso e logs por requisição;
- usa fetchers específicos para providers que expõem quota, como Gemini CLI, GLM e MiniMax, em vez de assumir um endpoint comum.

Quando o BrightCode estiver conectado ao 9Router, a aba Usage poderá consumir os endpoints de dashboard/usage do gateway e identificar a origem como `9Router`. Nesse modo, o 9Router pode fornecer quota agregada, uso por provider/modelo e disponibilidade das contas. Quando a conexão for direta com o provider, o BrightCode deve usar o adapter nativo e deixar “quota indisponível” quando não houver API confiável.

Referências: [arquitetura de usage do 9Router](https://github.com/decolua/9router/blob/master/docs/ARCHITECTURE.md), [dashboard e quota em tempo real](https://tunnel.9router.com/), [fetchers específicos de quota](https://github.com/decolua/9router/blob/master/CHANGELOG.md).

### Fase 6 — integração opcional com 9Router

- [ ] Cadastrar 9Router como gateway externo.
- [ ] Permitir endpoint local e aliases de modelos.
- [ ] Delegar quota, rotação e failover ao 9Router quando escolhido.
- [ ] Evitar duplicar inicialmente toda a lógica de roteamento do 9Router no BrightCode.
- [ ] Integrar os dados de usage do gateway à aba `Settings > Usage`.
- [ ] Exibir a origem dos dados e o horário da última sincronização.
- [ ] Tratar indisponibilidade do dashboard sem interromper o streaming.

### Fase 7 — completar catálogo e qualidade

- [ ] Alinhar README, documentação e bootstrap de providers.
- [ ] Adicionar MiniMax, PayPerQ e OpenRouter somente com adapters testados.
- [ ] Criar testes de migração, login, troca de conta e expiração.
- [ ] Criar testes de streaming, falha de provider e seleção por sessão.
- [ ] Adicionar smoke tests e validação no build Electron.

## Primeira entrega recomendada

A primeira implementação deve conter somente:

1. `AccountStore` e migração automática para `default`.
2. Armazenamento seguro dos segredos.
3. Lista de contas e botão “Adicionar conta”.
4. Seleção de conta no provider/modelo.
5. Persistência da conta por sessão.
6. Detecção de múltiplos perfis de CLI.

Fallback, round-robin, quota avançada e integração com 9Router podem vir depois, sem bloquear o uso normal.

## Critérios de aceite

- A instalação atual inicia sem exigir novo login.
- É possível cadastrar duas contas no mesmo provider.
- É possível escolher contas diferentes em sessões diferentes.
- Reiniciar o app preserva contas e seleção.
- Tokens não aparecem no renderer, logs ou mensagens do chat.
- Uma conta inválida não impede o uso das demais.
- A troca de conta não interrompe uma execução em andamento.
- Os providers existentes continuam funcionando durante a migração.

## Fora do escopo imediato

- Automação completa.
- Agent Teams.
- Criptografia avançada além do armazenamento seguro das credenciais.
- Roteamento inteligente completo antes da fundação de contas estar estável.
