# luke-voice

**Read in English: [README.md](README.md)**

A Ceci, uma assistente de voz ao lado do Claude Code, em português do Brasil. Você fala o que quer, ela repete e pergunta "posso?", e depois do seu "sim" um subagente do Claude Code faz a tarefa no seu computador. Quando termina, ela conta o resultado em voz alta.

A Ceci tem duas vozes:

| | Voz gratuita (padrão) | Voz ElevenLabs (opcional) |
| --- | --- | --- |
| Custo | Grátis. Usa a sua conta do Claude para as respostas curtas. | Paga por uso (o plano grátis dá cerca de 15 minutos por mês). |
| Onde roda | No seu computador. Os modelos rodam localmente (voz natural num computador com boa placa de vídeo, voz leve em qualquer outro). | Num agente da ElevenLabs, pela internet. |
| O que precisa | Nada a mais. O instalador baixa a voz uma vez só: cerca de 2,8 GB (voz natural) ou cerca de 320 MB (voz leve). | Uma chave da ElevenLabs. |
| Som | Voz natural: clonada de um trecho de referência, em português do Brasil. Voz leve: boa, um pouco sintética. | O mais natural. |

> Não tem ligação oficial com a ElevenLabs. A voz ElevenLabs usa a API pública da ElevenLabs com a sua própria chave.

### Os dois perfis da voz gratuita

O luke-voice escolhe o perfil sozinho, na hora da instalação:

| | perfil gpu ("voz natural") | perfil light ("voz leve") |
| --- | --- | --- |
| Quando | O llama.cpp enxerga uma GPU com pelo menos 6 GB de memória de vídeo (NVIDIA, AMD ou Intel pelo Vulkan no Windows e no Linux; Apple Silicon pelo Metal no macOS arm64). | Todo o resto. |
| Fala | Qwen3-TTS 12Hz 0.6B Base, clonada na hora a partir de `agent/ceci-voice.wav` e da transcrição `agent/ceci-voice.txt`. | Kokoro-82M no navegador. O Piper `pt_BR-faber` é o plano B em computadores lentos. |
| Ouve | Qwen3-ASR 0.6B. | Whisper base no navegador. |
| Conversa rápida | Um roteador local instantâneo, o Qwen3.5 0.8B na CPU. | Vai para o Claude Haiku como todo o resto. |
| Download | Cerca de 2,8 GB, uma vez só. Sem Python, sem PyTorch. | Cerca de 320 MB, uma vez só (cerca de 480 MB numa máquina com GPU pequena, onde o Kokoro roda em fp32 no WebGPU). |

No perfil gpu, o hub baixa a versão oficial b12556 do llama.cpp (fixada por sha256, cerca de 39 MB) e roda três processos `llama-server` locais: a voz da Ceci, os ouvidos dela e o roteador.

`LUKE_VOICE_PROFILE=gpu` ou `light` força um perfil: variável de ambiente do instalador, ou do hub (ele prepara esse perfil quando iniciar de novo).

## Instalação em 5 passos

Cada passo diz como saber que deu certo. Faça na ordem.

**Ou deixe o Claude Code fazer:** com os passos 1 e 2 feitos, mande esta mensagem para o Claude Code: *"Instale o luke-voice seguindo https://github.com/lukeware-hub/luke-voice/blob/main/INSTALL.md"*. O [INSTALL.md](INSTALL.md) tem uma seção para agentes de IA com os comandos exatos.

### 1. Tenha o Claude Code funcionando

Instale em [claude.com/claude-code](https://claude.com/claude-code), abra e entre na sua conta uma vez.
**Deu certo quando:** você escreve uma mensagem no Claude Code e recebe resposta.

### 2. Instale o Node.js 20 ou mais novo

Baixe a versão **LTS** em [nodejs.org](https://nodejs.org) e instale com as opções padrão. O luke-voice usa o Node.js para rodar um pequeno servidor no seu computador.
**Deu certo quando:** o comando `node -v` num terminal mostra `v20` ou maior.

### 3. Tenha o Google Chrome

A janela da chamada abre no Chrome, num perfil só dela, então o seu Chrome normal não muda. Sem o Chrome, qualquer navegador com microfone funciona, mas talvez você precise liberar o microfone na mão.

### 4. Rode o instalador

- **Windows:** abra o PowerShell e cole esta linha:

  ```powershell
  powershell -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd | iex"
  ```

  Ou baixe o [install-luke-voice-windows.cmd](https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd) e dê dois cliques nele. Se o Windows disser "O Windows protegeu o computador", clique em **Mais informações** e depois em **Executar assim mesmo**.
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

O instalador tem 6 etapas. A última, **Downloading Ceci's voice (up to 3 GB, only once)** (baixando a voz da Ceci, até 3 GB, uma vez só), roda `node hub/setup.mjs`. Ela escolhe o perfil, baixa tudo e confere cada arquivo por sha256. Se o download for cortado, ele continua de onde parou. No perfil gpu, ela também faz um teste curto: a Ceci fala uma frase, os ouvidos dela escrevem de volta e o roteador responde a um cumprimento. Se o teste falhar, o setup baixa também a voz leve (de 320 a 480 MB) e as chamadas usam ela até o `/luke-voice setup` passar no teste.

**Deu certo quando:** aparece a mensagem verde **Installation complete**. Se ele parar, leia a linha **What to do**, resolva aquilo e rode de novo.

Para instalar sem perguntas, defina `LUKE_VOICE_PROVIDER=local` (ou `elevenlabs`) e `LUKE_VOICE_NO_PROMPT=1` antes de rodar. Acrescente `LUKE_VOICE_PROFILE=gpu` ou `light` para forçar o perfil. `LUKE_VOICE_REF=<branch ou tag>` instala essa versão em vez da `main`, para testar uma mudança.

### 5. Reinicie o Claude Code e ligue

1. **Feche o Claude Code por completo e abra de novo.** O `/reload-plugins` não basta para carregar uma instalação ou atualização nova.
2. Acima do prompt aparece **✦ luke-voice: off**. Clique. Ele vira **on**, uma janela abre e a chamada começa sozinha.
3. A primeira chamada:
   - **Voz gratuita:** o instalador já baixou a voz. Se você atualizou pelo marketplace e nada foi baixado ainda, rode `/luke-voice setup`. Ou simplesmente ligue: a primeira chamada prepara a voz, com o progresso na janela.
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
| `/luke-voice setup` | baixa e confere a voz gratuita da Ceci (para quem atualiza pelo marketplace) |
| `/luke-voice status` | estado técnico: hub, voz, perfil, chamada, chave, fila, progresso do setup |
| `/luke-voice help` | tudo que você precisa saber, e o que está faltando |

Ele começa **desligado** e lembra a sua escolha. Quando o Claude Code abre com ele ligado, ele só reconecta: nunca começa uma chamada que você não pediu.

O `/luke-voice setup` faz o mesmo que a etapa 6 do instalador, de dentro do Claude Code. Com o luke-voice ligado, o hub prepara a voz em segundo plano e o `/luke-voice status` mostra o progresso. Com ele desligado, o setup roda direto (até 10 minutos por execução; um download cortado continua na próxima vez).

### Um cérebro mais rápido

O cérebro da Ceci é o Claude Haiku 5.5, chamado direto pelo `$.model.complete` do motor de mods, com esforço baixo e prompt em cache. A chamada `claude -p` ficou só como plano B. Os turnos do cérebro medidos levam de 0,9 a 2,8 s (levavam de 6 a 28 s).

Algumas coisas não precisam de chamada ao modelo:
- "pare" ou "para" para o Claude.
- Quando a Ceci pergunta "posso?", um "sim" simples roda a ação pendente na hora, e um "não" simples cancela.
- Quando o cérebro demora mais de 600 ms, a Ceci diz um reconhecimento curto ("Certo.", "Deixa eu ver.").
- No perfil gpu, um roteador local responde conversa rápida (cumprimentos, agradecimentos, despedidas, "quem é você", a idade dela, quem a criou) em cerca de 0,3 s, com frases escritas em `hub/router.mjs`, então ele nunca inventa nada. Todo o resto, e qualquer pedido, vai para o Claude Haiku. Uma checagem de palavras por cima do modelo pequeno garante que um pedido nunca seja respondido localmente (0 de 49 pedidos de teste foram).

### Saber quando você terminou de falar

O Silero VAD (MIT) descarta sons sem fala. O Pipecat Smart Turn v3.2 (BSD-2-Clause) decide quando você terminou de falar: ele é consultado depois de uma pausa de 0,7 s, e só um "terminou" claro encerra a sua vez. 2 s de silêncio sempre encerram (1,3 s sem o modelo). Uma respiração no meio da frase dura até cerca de 1 s, então não te corta. Se você continuar falando antes de a Ceci começar a responder, as duas partes viram um pedido só.

### Quão rápido é

Medido numa RTX 3060 Ti, perfil gpu:
- primeiro áudio de uma resposta: 0,74 a 0,94 s;
- transcrição: cerca de 0,25 s;
- fim do turno: cerca de 0,18 s;
- "sim" depois de "posso?" até "Comecei": cerca de 0,7 s.

A voz foi escolhida pelo dono, ouvindo:
- Uma voz anterior, desenhada com o Qwen3-TTS VoiceDesign, foi bem em juízes automáticos, mas o dono ouviu sotaque de Portugal nela. O classificador de sotaque usado na época também chamava de europeias algumas gravações brasileiras reais, então deixou de ser usado como juiz.
- Agora a Ceci clona uma locutora brasileira real: um trecho do banco CML-TTS em português (veja os Créditos).
- O trecho foi deixado mais alegre (um pouco mais agudo, com mais melodia e 8% mais rápido), porque a leitura original soava sonolenta.
- O dono comparou as candidatas de ouvido e escolheu esta.

Em 40 frases em pt-BR pelo caminho de produção:
- nenhuma frase falhou nem entrou em repetição;
- os erros de palavras ficaram em 8% (Whisper large-v3-turbo), quase todos em palavras técnicas em inglês ("branch", "main") e em números escritos com algarismos.

As perguntas terminam subindo, do jeito brasileiro: a janela sobe o tom do último meio segundo de uma pergunta depois que ela é gerada, sem mudar a duração (`window/engines/question-rise.js`). Em 20 perguntas, o fim agora sobe +3,4 semitons (antes +2,0, como uma afirmação), e o Whisper reconhece 9 de 20 como perguntas (antes 6). O dono escolheu essa versão de ouvido, entre três. `?voice-question=0` desliga.

### Trocar a voz

Escolha de qualquer um destes jeitos; vale a escolha mais recente:
- `/luke-voice voz local` ou `/luke-voice voz elevenlabs` no Claude Code (vale a partir da próxima chamada);
- o instalador;
- `/plugin configure luke-voice@luke-voice`, opção **voice_provider**.

Sem nenhuma escolha, o luke-voice usa a ElevenLabs se houver chave salva, e a voz gratuita se não houver.

### O que sai do seu computador

- **Desligado:** nada.
- **Voz gratuita:** o áudio não sai do seu computador. Só o texto do que você falou, um resumo curto do que acontece na sessão e o resultado das tarefas vão para o Claude Haiku, da sua conta do Claude, que decide o que a Ceci fala. Os arquivos dos modelos são baixados uma vez (do Hugging Face e do GitHub): na instalação ou no setup, ou na primeira chamada se nenhum dos dois rodou. Depois disso, nada é baixado.
- **Voz ElevenLabs:** a sua voz e o que acontece na sessão (seus pedidos e as ferramentas que o Claude usa) vão para o seu agente na ElevenLabs.

## Se algo não funcionar

| O que aparece | O que fazer |
| --- | --- |
| Não ouço nada | Veja se o som do computador está ligado e se a janela mostra **Em chamada**. |
| A voz não foi baixada na instalação | Rode `/luke-voice setup`. Ou comece uma chamada: a primeira chamada baixa a voz, com o progresso na janela. |
| A Ceci usa a voz leve num computador com placa de vídeo | A GPU tem menos de 6 GB de memória de vídeo, ou o teste do setup falhou. O `/luke-voice status` mostra o perfil. O `/luke-voice setup` tenta de novo. |
| A Ceci demora alguns segundos para responder | Os pedidos que vão para o Claude Haiku levam cerca de 1 a 3 segundos. No perfil gpu, a conversa rápida é instantânea. No perfil light, um computador sem placa de vídeo também leva 1 a 2 segundos a mais para ouvir e falar. |
| A voz gratuita ficou mais robótica | Num computador lento, o perfil light troca para o Piper, uma voz mais leve, para não falar travado. **Configurações**, na janela, mostra qual modelo de voz está falando. |
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

## Como funciona

A janela da chamada fala com o hub (`hub/server.mjs`, em 127.0.0.1:4848). Na voz gratuita há dois caminhos:
- **Navegador (perfil light):** microfone, detector de voz, Whisper, `POST /brain`, Kokoro (ou Piper) para falar.
- **Motor nativo (perfil gpu):** microfone, Silero VAD e Smart Turn, depois o hub (`/stt`, `/tts`, `/route`) e os `llama-server` locais: Qwen3-ASR (ouvidos), Qwen3-TTS (voz) e Qwen3.5 0.8B (roteador). Os pedidos vão para o `/brain`.

O hub serve todos os arquivos de modelo a partir de `~/.luke-voice/models`, fixados por revisão do Hugging Face e sha256 (o projetor convertido do Qwen3-TTS, `qwen3-tts-0.6b-base-mmproj-icl-q8_0.gguf`, vem do prerelease `voice-models-v1` deste repositório no GitHub). A janela da chamada não baixa nada do Hugging Face. O manifesto é o `hub/models.mjs`; o manifesto e o motor do llama.cpp ficam em `hub/engine.mjs`; o `hub/setup.mjs` é o CLI de setup; o `hub/router.mjs` é o roteador.

## Segurança

- Os binários do llama.cpp são arquivos oficiais de release do GitHub, fixados por sha256.
- Todo arquivo de modelo é fixado por revisão e sha256 e conferido antes do uso.
- Os servidores nativos escutam só em 127.0.0.1, em portas aleatórias.
- O `/stt`, o `/tts` e o `/route` do hub exigem a chave da janela.

Os demais detalhes de segurança estão no [README.md](README.md#security), em inglês.

## Desenvolvimento

```bash
claude --plugin-dir .                 # carrega este clone, com recarga automática
claude plugin validate .
claude plugin test .
node --test hub/*.test.mjs window/*.test.mjs window/engines/*.test.mjs
```

Chaves para testar a voz gratuita, no fim da URL da janela:

| Chave | O que faz |
| --- | --- |
| `&voice-echo=1` | A Ceci repete o que ouviu, em vez de pensar |
| `&voice-native=0` | Força a voz do navegador (leve) mesmo com o motor nativo rodando |
| `&voice-debug=1` | Registra os níveis do microfone |
| `&voice-device=wasm` | Roda o Kokoro na CPU, mesmo com placa de vídeo |
| `&voice-tts=piper` ou `kokoro` | Força o modelo de voz |
| `&voice-dtype=`, `&voice-stt-dtype=`, `&voice-stt-device=`, `&voice-threads=` | Precisão do modelo, dispositivo do Whisper, threads de CPU |

Variáveis de ambiente: `LUKE_VOICE_PROFILE=gpu|light` força o perfil, e `LUKE_VOICE_ENGINE=off` impede o hub de iniciar o motor nativo.

## Licença

MIT. Escrito do zero; não divide código com outros mods de voz.

A voz gratuita baixa na instalação partes de terceiros; nenhuma delas está neste repositório:
- llama.cpp: MIT.
- Qwen3-TTS 0.6B Base, Qwen3-ASR 0.6B e Qwen3.5 0.8B: Apache-2.0.
- Pipecat Smart Turn v3.2: BSD-2-Clause.
- Silero VAD: MIT.
- Kokoro-82M: Apache-2.0.
- Whisper: MIT.
- transformers.js e onnxruntime-web: Apache-2.0 e MIT.
- A voz do Piper: veja o cartão do modelo.
- espeak-ng (pelo espeak-phonemizer): GPL-3.0.

O trecho de voz de referência da Ceci, `agent/ceci-voice.wav`, vem do CML-TTS (Oliveira et al., 2023), português, locutora 3050, licença CC-BY-4.0; a gravação é uma leitura do LibriVox em domínio público. Ele foi alterado para este projeto: cortado, um semitom mais agudo, com mais melodia e 8% mais rápido.

Mais detalhes, em inglês, no [README.md](README.md).
