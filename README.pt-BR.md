# luke-voice

**Read in English: [README.md](README.md)**

A Ceci, uma assistente de voz ao lado do Claude Code, em português do Brasil. Você fala o que quer, ela repete e pergunta "posso?", e depois do seu "sim" um subagente do Claude Code faz a tarefa no seu computador. Quando termina, ela conta o resultado em voz alta.

A Ceci tem duas vozes:

| | Voz gratuita (padrão) | Voz ElevenLabs (opcional) |
| --- | --- | --- |
| Custo | Grátis. Usa a sua conta do Claude para as respostas curtas. | Paga por uso (o plano grátis dá cerca de 15 minutos por mês). |
| Onde roda | No seu computador, na janela da chamada (Whisper para ouvir, Kokoro para falar). | Num agente da ElevenLabs, pela internet. |
| O que precisa | Nada a mais. A primeira chamada baixa de 270 a 430 MB, uma vez só. | Uma chave da ElevenLabs. |
| Som | Bom, um pouco sintético em português. | O mais natural. |

> Não tem ligação oficial com a ElevenLabs. A voz ElevenLabs usa a API pública da ElevenLabs com a sua própria chave.

## Instalação em 5 passos

Cada passo diz como saber que deu certo. Faça na ordem.

### 1. Tenha o Claude Code funcionando

Instale em [claude.com/claude-code](https://claude.com/claude-code), abra e entre na sua conta uma vez.
**Deu certo quando:** você escreve uma mensagem no Claude Code e recebe resposta.

### 2. Instale o Node.js 20 ou mais novo

Baixe a versão **LTS** em [nodejs.org](https://nodejs.org) e instale com as opções padrão. O luke-voice usa o Node.js para rodar um pequeno servidor no seu computador.
**Deu certo quando:** o comando `node -v` num terminal mostra `v20` ou maior.

### 3. Tenha o Google Chrome

A janela da chamada abre no Chrome, num perfil só dela, então o seu Chrome normal não muda. Sem o Chrome, qualquer navegador com microfone funciona, mas talvez você precise liberar o microfone na mão.

### 4. Rode o instalador

- **Windows:** baixe o [install-luke-voice-windows.cmd](https://github.com/lukeware-hub/luke-voice/releases/latest/download/install-luke-voice-windows.cmd) e dê dois cliques nele. Se o Windows disser "O Windows protegeu o computador", clique em **Mais informações** e depois em **Executar assim mesmo**.
- **macOS / Linux:** cole isto no Terminal:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
  ```

Quando ele perguntar **Which voice should Ceci use?** (qual voz a Ceci deve usar):
- Aperte **Enter** para a voz gratuita. Não precisa de mais nada.
- Ou digite **e** para a ElevenLabs. Aí ele pede a **Key** (chave). Para pegar uma:
  1. Crie uma conta em [elevenlabs.io](https://elevenlabs.io).
  2. Abra [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) e clique em **Create API key**. Se perguntar as permissões, deixe **Agents** e **Voices** liberadas.
  3. Cole a chave e aperte Enter. Ela fica escondida.

**Deu certo quando:** aparece a mensagem verde **Installation complete**. Se ele parar, leia a linha **What to do**, resolva aquilo e rode de novo.

Para instalar sem perguntas, defina `LUKE_VOICE_PROVIDER=local` (ou `elevenlabs`) e `LUKE_VOICE_NO_PROMPT=1` antes de rodar.

### 5. Reinicie o Claude Code e ligue

1. **Feche o Claude Code por completo e abra de novo.** O `/reload-plugins` não basta para carregar uma instalação ou atualização nova.
2. Acima do prompt aparece **✦ luke-voice: off**. Clique. Ele vira **on**, uma janela abre e a chamada começa sozinha.
3. A primeira chamada demora mais:
   - **Voz gratuita:** a janela mostra "Baixando a voz gratuita… N%" enquanto baixa de 270 a 430 MB, uma vez só.
   - **ElevenLabs:** o luke-voice cria um agente chamado `luke-voice` e adiciona a voz "Roberta" na sua conta.

**Deu certo quando:** você ouve "Oi! Eu sou a Ceci. O que vamos fazer hoje?". Se faltar alguma coisa, digite `/luke-voice help`: ele confere a sua instalação e diz o que arrumar.

## Como usar

Fale normalmente, em português. Exemplo: *"Verifica no repositório luke-voice onde o botão de ligar é desenhado."*
1. A Ceci repete e pergunta "posso?". Diga "sim".
2. O pedido aparece em **Histórico**, na janela.
3. Ela conta a resposta quando o subagente terminar. O chat principal fica livre.

Diga **"pare"** (ou "para tudo", "Ceci, para") para parar o Claude na hora.

| | |
| --- | --- |
| o botão **✦ luke-voice** | liga (abre a janela e começa a chamada) ou desliga |
| `/luke-voice` | o mesmo que o botão |
| `/luke-voice call` | abre a janela e começa a chamada |
| `/luke-voice end` | encerra a chamada |
| `/luke-voice window` | traz a janela para a frente |
| `/luke-voice voz` | mostra a voz; `voz local` ou `voz elevenlabs` troca a voz para a próxima chamada |
| `/luke-voice status` | estado técnico: hub, voz, chamada, chave, fila |
| `/luke-voice help` | tudo que você precisa saber, e o que está faltando |

Ele começa **desligado** e lembra a sua escolha. Quando o Claude Code abre com ele ligado, ele só reconecta: nunca começa uma chamada que você não pediu.

### Trocar a voz

Escolha de qualquer um destes jeitos; vale a escolha mais recente:
- `/luke-voice voz local` ou `/luke-voice voz elevenlabs` no Claude Code (vale a partir da próxima chamada);
- o instalador;
- `/plugin configure luke-voice@luke-voice`, opção **voice_provider**.

Sem nenhuma escolha, o luke-voice usa a ElevenLabs se houver chave salva, e a voz gratuita se não houver.

### O que sai do seu computador

- **Desligado:** nada.
- **Voz gratuita:** o áudio não sai do seu computador. O texto do que você falou, um resumo curto do que acontece na sessão e o resultado das tarefas vão para o Claude Haiku, da sua conta do Claude, que decide o que a Ceci fala. Os modelos de voz baixam do Hugging Face na primeira vez.
- **Voz ElevenLabs:** a sua voz e o que acontece na sessão (seus pedidos e as ferramentas que o Claude usa) vão para o seu agente na ElevenLabs.

## Se algo não funcionar

| O que aparece | O que fazer |
| --- | --- |
| Não ouço nada | Veja se o som do computador está ligado e se a janela mostra **Em chamada**. |
| A primeira chamada gratuita demora minutos | Ela está baixando a voz (de 270 a 430 MB), uma vez só. A janela mostra a porcentagem. |
| A Ceci demora alguns segundos para responder | Normal: ela pensa com o Claude Haiku. Num computador sem placa de vídeo, a voz gratuita também leva 1 a 2 segundos a mais para ouvir e falar. |
| A voz gratuita ficou mais robótica | Num computador lento, a Ceci troca para o Piper, uma voz mais leve, para não falar travado. **Configurações**, na janela, mostra qual modelo de voz está falando. |
| "Falta a chave da ElevenLabs" ou "Chave: faltando" | Salve a chave com `/plugin configure luke-voice@luke-voice` (ou rode o instalador de novo) e reinicie o Claude Code. Ou use a voz gratuita: `/luke-voice voz local`. |
| Troquei a chave da ElevenLabs e nada mudou | A chave fica guardada pelo Claude Code (no Mac, no Keychain). Uma chave exportada no `~/.zshrc` não chega a um Claude Code aberto pelo Dock. Salve com `/plugin configure` e reinicie o Claude Code. |
| O microfone não funciona | Na janela da chamada, libere o microfone e toque em **Chamar** de novo. |
| A janela mostra **Hub offline** | Ligue o luke-voice no Claude Code; a janela volta sozinha. |
| ElevenLabs: a chamada parou de conectar | Os minutos grátis do mês podem ter acabado. Veja o seu uso em elevenlabs.io, ou troque para a voz gratuita. |
| A janela continua com o visual antigo | Feche o Claude Code por completo e abra de novo. |
| Instalador: "Claude Code was not found" ou "Node.js was not found" | Faça o passo 1 ou o passo 2 e rode o instalador de novo. |
| Qualquer outra coisa | Digite `/luke-voice status` e mande o resultado para quem cuida do luke-voice. |

## Desinstalar

No Claude Code, digite `/plugin`, escolha **luke-voice** e **Uninstall**. Ou rode `claude plugin uninstall luke-voice@luke-voice`.

## Mais detalhes

Como funciona por dentro, segurança, desenvolvimento e licenças estão no [README.md](README.md#how-it-works), em inglês.
