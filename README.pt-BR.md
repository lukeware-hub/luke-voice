# luke-voice

**Read in English: [README.md](README.md)**

A Ceci, uma assistente de voz ao lado do Claude Code, em português do Brasil. Você fala o que quer, ela repete e pergunta "posso?", e depois do seu "sim" um subagente do Claude Code faz a tarefa no seu computador. Quando termina, ela conta o resultado em voz alta.

> Não tem ligação oficial com a ElevenLabs. O luke-voice usa a API pública da ElevenLabs com a sua própria chave.

## Instalação em 6 passos

Cada passo diz como saber que deu certo. Faça na ordem.

### 1. Tenha o Claude Code funcionando

Instale em [claude.com/claude-code](https://claude.com/claude-code), abra e entre na sua conta uma vez.
**Deu certo quando:** você escreve uma mensagem no Claude Code e recebe resposta.

### 2. Instale o Node.js 20 ou mais novo

Baixe a versão **LTS** em [nodejs.org](https://nodejs.org) e instale com as opções padrão. O luke-voice usa o Node.js para rodar um pequeno servidor no seu computador.
**Deu certo quando:** o comando `node -v` num terminal mostra `v20` ou maior.

### 3. Tenha o Google Chrome

A janela da chamada abre no Chrome, num perfil só dela, então o seu Chrome normal não muda. Sem o Chrome, qualquer navegador com microfone funciona, mas talvez você precise liberar o microfone na mão.

### 4. Pegue uma chave da ElevenLabs

1. Crie uma conta grátis em [elevenlabs.io](https://elevenlabs.io).
2. Abra [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) e clique em **Create API key**. Se perguntar as permissões, deixe **Agents** e **Voices** liberadas (o mais simples é uma chave sem limites).
3. Copie a chave. Ela aparece uma vez só.

O plano grátis dá cerca de **15 minutos de chamada por mês**. As chamadas são cobradas na sua conta.

### 5. Rode o instalador

- **Windows:** baixe o [install-luke-voice-windows.cmd](https://github.com/lukeware-hub/luke-voice/releases/latest/download/install-luke-voice-windows.cmd) e dê dois cliques nele. Se o Windows disser "O Windows protegeu o computador", clique em **Mais informações** e depois em **Executar assim mesmo**.
- **macOS / Linux:** cole isto no Terminal:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
  ```

Quando ele pedir a **Key**, cole a chave do passo 4 e aperte Enter (ela fica escondida).
**Deu certo quando:** aparece a mensagem verde **Installation complete**. Se ele parar, leia a linha **What to do**, resolva aquilo e rode de novo.

### 6. Reinicie o Claude Code e ligue

1. **Feche o Claude Code por completo e abra de novo.** O `/reload-plugins` não basta para carregar uma instalação ou atualização nova.
2. Acima do prompt aparece **✦ luke-voice: off**. Clique. Ele vira **on**, uma janela abre e a chamada começa sozinha.
3. A primeira chamada demora uns segundos a mais: o luke-voice cria um agente chamado `luke-voice` e adiciona a voz "Roberta" na sua conta da ElevenLabs.

**Deu certo quando:** você ouve "Oi! Estou aqui. O que vamos fazer?". Se faltar alguma coisa, digite `/luke-voice help`: ele confere a sua instalação e diz o que arrumar.

## Como usar

Fale normalmente, em português. Exemplo: *"Verifica no repositório luke-voice onde o botão de ligar é desenhado."* Ela repete e pergunta "posso?". Diga "sim". O pedido aparece em **Histórico**, na janela, e ela conta a resposta quando o subagente terminar. O chat principal fica livre.

| | |
| --- | --- |
| o botão **✦ luke-voice** | liga (abre a janela e começa a chamada) ou desliga |
| `/luke-voice` | o mesmo que o botão |
| `/luke-voice call` | abre a janela e começa a chamada |
| `/luke-voice end` | encerra a chamada |
| `/luke-voice window` | traz a janela para a frente |
| `/luke-voice status` | estado técnico: hub, chamada, chave, fila |
| `/luke-voice help` | tudo que você precisa saber, e o que está faltando |

Ele começa **desligado** e lembra a sua escolha. Quando o Claude Code abre com ele ligado, ele só reconecta: nunca começa uma chamada que você não pediu. **Enquanto está ligado**, o que acontece na sessão (seus pedidos e as ferramentas que o Claude usa) é enviado ao seu agente na ElevenLabs. **Desligado**, nada sai do seu computador.

## Se algo não funcionar

| O que aparece | O que fazer |
| --- | --- |
| Não ouço nada | Veja se o som do Windows está ligado e se a janela mostra **Em chamada**. |
| "No ElevenLabs API key" ou "Chave: faltando" | Salve a chave com `/plugin configure luke-voice@luke-voice` (ou rode o instalador de novo) e reinicie o Claude Code. |
| A janela mostra **Hub offline** | Ligue o luke-voice no Claude Code; a janela volta sozinha. |
| A chamada parou de conectar | Os minutos grátis do mês podem ter acabado. Veja o seu uso em elevenlabs.io. |
| A janela continua com o visual antigo | Feche o Claude Code por completo e abra de novo. |
| Instalador: "Claude Code was not found" ou "Node.js was not found" | Faça o passo 1 ou o passo 2 e rode o instalador de novo. |
| Qualquer outra coisa | Digite `/luke-voice status` e mande o resultado para quem cuida do luke-voice. |

## Desinstalar

No Claude Code, digite `/plugin`, escolha **luke-voice** e **Uninstall**. Ou rode `claude plugin uninstall luke-voice@luke-voice`.

## Mais detalhes

Como funciona por dentro, segurança e desenvolvimento estão no [README.md](README.md#how-it-works), em inglês.
