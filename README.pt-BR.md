# luke-voice

**Read in English: [README.md](README.md)**

A Ceci, uma assistente de voz ao lado do Claude Code, em português do Brasil. Você fala o que quer, ela repete e pergunta "ok?", e depois do seu "sim" um subagente do Claude Code faz a tarefa no seu computador. Quando termina, ela conta o resultado em voz alta, sem esperar você falar: se não houver chamada, ela abre uma, e um resultado que chega com a janela fechada fica guardado até ela contar.

A Ceci tem duas vozes:

| | Voz gratuita (padrão) | Voz ElevenLabs (opcional) |
| --- | --- | --- |
| Custo | Grátis. Usa a sua conta do Claude para as respostas curtas. | Paga por uso (o plano grátis dá cerca de 15 minutos por mês). |
| Onde roda | No seu computador. Os modelos rodam localmente (voz natural num computador com boa placa de vídeo, voz leve em qualquer outro). | Num agente da ElevenLabs, pela internet. |
| O que precisa | Nada a mais. O instalador baixa a voz uma vez só: cerca de 3,3 GB (voz natural) ou cerca de 360 MB (voz leve). | Uma chave da ElevenLabs. |
| Som | Voz natural: clonada de um trecho de referência, em português do Brasil. Voz leve: boa, um pouco sintética. | O mais natural. |

> Não tem ligação oficial com a ElevenLabs. A voz ElevenLabs usa a API pública da ElevenLabs com a sua própria chave.

### Os dois perfis da voz gratuita

O luke-voice escolhe o perfil sozinho, na hora da instalação:

| | perfil gpu ("voz natural") | perfil light ("voz leve") |
| --- | --- | --- |
| Quando | O llama.cpp enxerga uma GPU com pelo menos 6 GB de memória de vídeo (NVIDIA, AMD ou Intel pelo Vulkan no Windows e no Linux; Apple Silicon pelo Metal no macOS arm64). A partir de 3,8 GB (uma placa de 4 GB, um Mac com 8 GB) continua a voz original da Ceci, com os ouvidos no processador: cerca de meio segundo a mais para ouvir cada fala. | Todo o resto. |
| Fala | Qwen3-TTS 12Hz 1.7B Base, clonada na hora a partir de `agent/ceci-voice.wav` e da transcrição `agent/ceci-voice.txt`. | Kokoro-82M no navegador. O Piper `pt_BR-faber` é o plano B em computadores lentos. |
| Ouve | Qwen3-ASR 0.6B (Q6). | Whisper base no navegador. |
| Conversa rápida | Um roteador local instantâneo, o Qwen3.5 0.8B na CPU. | Vai para o Claude Sonnet como todo o resto. |
| Download | Cerca de 3,3 GB, uma vez só (3,24 GB de modelos e o motor llama.cpp de 39 MB). Sem Python, sem PyTorch. | Cerca de 360 MB, uma vez só (cerca de 520 MB numa máquina com GPU pequena, onde o Kokoro roda em fp32 no WebGPU). |
| Memória de vídeo numa chamada | Cerca de 5,4 GB para a voz e os ouvidos juntos, e cerca de 3,2 GB de RAM para o motor inteiro (medido numa RTX 3060 Ti). | Nada além do que o navegador usa. |

No perfil gpu, o hub baixa a versão oficial b12556 do llama.cpp (fixada por sha256, cerca de 39 MB) e roda três processos `llama-server` locais: a voz da Ceci, os ouvidos dela e o roteador.

`LUKE_VOICE_PROFILE=gpu` ou `light` força um perfil: variável de ambiente do instalador, ou do hub (ele prepara esse perfil quando iniciar de novo).

## Instalação em 3 passos

Cada passo diz como saber que deu certo. Faça na ordem.

**Ou deixe o Claude Code fazer:** com o passo 1 feito, mande esta mensagem para o Claude Code: *"Instale o luke-voice seguindo https://github.com/lukeware-hub/luke-voice/blob/main/INSTALL.md"*. O [INSTALL.md](INSTALL.md) tem uma seção para agentes de IA com os comandos exatos.

### 1. Tenha o Claude Code funcionando

Instale em [claude.com/claude-code](https://claude.com/claude-code), abra e entre na sua conta uma vez.
**Deu certo quando:** você escreve uma mensagem no Claude Code e recebe resposta.

Não precisa de mais nada antes. O instalador traz o Node.js e o Git quando faltam (só para você: sem administrador e sem senha). O Google Chrome é o melhor para a janela da chamada, que abre num perfil só dela; qualquer navegador com microfone também funciona, mas talvez você precise liberar o microfone na mão.

### 2. Rode o instalador

- **Windows:** aperte **Windows + R**, cole esta linha e aperte **Enter**:

  ```
  powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd | iex"
  ```

  A mesma linha funciona digitada no PowerShell ou no Prompt de Comando. Aberta pelo Windows + R, a janela espera um Enter antes de fechar. Ou baixe o [install-luke-voice-windows.cmd](https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd) e dê dois cliques nele. Se o Windows disser "O Windows protegeu o computador", clique em **Mais informações** e depois em **Executar assim mesmo**.
- **macOS / Linux:** cole isto no Terminal:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash
  ```

  Sem curl: `wget -qO- https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install.sh | bash`.

Quando ele perguntar **Qual voz a Ceci deve usar?**:
- Aperte **Enter** para a voz gratuita. Não precisa de mais nada.
- Ou digite **e** para a ElevenLabs. Aí ele pede a **Chave**. Para pegar uma:
  1. Crie uma conta em [elevenlabs.io](https://elevenlabs.io).
  2. Abra [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) e clique em **Create API key**. Se perguntar as permissões, deixe **Agents** e **Voices** liberadas.
  3. Cole a chave e aperte Enter. Ela fica escondida.

O instalador tem 6 etapas:
1. Procura o Claude Code.
2. Prepara o Node.js e o Git. O que faltar é baixado do site oficial, conferido por sha256 e guardado em `~/.luke-voice` só para você: o Node.js 24 LTS (cerca de 30 MB) e, no Windows, o MinGit, a versão portátil do Git para Windows (cerca de 40 MB). Um Node.js anterior ao 20, ou um que não baixa pelo seu proxy, conta como faltando: o luke-voice traz o dele e deixa o seu como está. Sem git no macOS ou no Linux, o luke-voice é baixado como arquivo compactado.
3. Instala o luke-voice no Claude Code.
4. Pergunta a voz.
5. Confere que o luke-voice está instalado e ativado.
6. **Baixando a voz da Ceci (até 3,3 GB, só uma vez)** roda `node hub/setup.mjs`. Ela escolhe o perfil, confere se o disco tem espaço (o que falta baixar mais 10%; se não tiver, para com **Falta espaço**), baixa tudo e confere cada arquivo por sha256. Se o download for cortado, ele continua de onde parou. No perfil gpu, ela também faz um teste curto: a Ceci fala uma frase, os ouvidos dela escrevem de volta e o roteador responde a um cumprimento. Se o teste falhar, o setup baixa também a voz leve (de 320 a 480 MB) e as chamadas usam ela até o `/luke-voice setup` passar no teste.

**Deu certo quando:** aparece a mensagem verde **Instalação concluída: luke-voice <versão>**. Se ele parar com **A instalação parou**, leia a linha **O que fazer**, resolva aquilo e rode de novo. Rodar de novo é sempre seguro.

Para instalar sem perguntas, defina `LUKE_VOICE_NO_PROMPT=1` antes de rodar; acrescente `LUKE_VOICE_PROVIDER=local` (ou `elevenlabs`) para escolher a voz, e `LUKE_VOICE_PROFILE=gpu` ou `light` para forçar o perfil. `LUKE_VOICE_REF=<branch ou tag>` instala essa versão em vez da `main`, para testar uma mudança.

### 3. Abra o Claude Code

1. **Feche o Claude Code por completo e abra de novo.** Se o instalador acabou de instalar o Node.js ou o Git, abra por uma janela nova do terminal. O `/reload-plugins` não basta para carregar uma instalação ou atualização nova.
2. Na primeira vez, o luke-voice liga sozinho, a janela da chamada abre e a Ceci cumprimenta você. É só falar.
   - **Voz gratuita:** o instalador já baixou a voz. Se você atualizou pelo marketplace e nada foi baixado ainda, a primeira chamada prepara a voz, com o progresso na janela (ou rode `/luke-voice setup`).
   - **ElevenLabs:** o luke-voice cria um agente chamado `luke-voice` e adiciona a voz "Roberta" na sua conta.
3. Depois disso: o **✦ luke-voice: on/off**, acima do prompt, liga e desliga, e o `/luke-voice call` começa uma chamada.

**No Mac:** na primeira chamada, o Mac pergunta se o Chrome pode usar o microfone: clique em **Permitir**. Um Mac com chip Apple fica com a voz natural; um Mac com Intel fica com a voz leve.

**Deu certo quando:** você ouve a Ceci te cumprimentar, por exemplo "Bom dia! Eu sou a Ceci. O que vamos fazer hoje?" ("bom dia", "boa tarde" ou "boa noite" pelo relógio, e as palavras mudam a cada chamada). Se faltar alguma coisa, digite `/luke-voice help`: ele confere a sua instalação e diz o que arrumar.

## Como usar

Fale normalmente, em português. Exemplo: *"Verifica no repositório luke-voice onde o botão de ligar é desenhado."*
1. A Ceci repete e pergunta "ok?". Diga "sim".
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
| `/luke-voice status` | estado técnico: hub, voz, perfil, chamada, chave, fila, progresso do setup, Prompt Master |
| `/luke-voice help` | tudo que você precisa saber, e o que está faltando |
| `/luke-voice update` | atualiza o luke-voice para a versão mais nova (atualiza a lista de versões e depois o plugin; feche e abra o Claude Code em seguida) |
| `/luke-voice uninstall` | remove o luke-voice e a voz baixada (pede `/luke-voice uninstall confirmar` antes) |

Ele começa **desligado** e lembra a sua escolha. Quando o Claude Code abre com ele ligado, ele só reconecta: nunca começa uma chamada que você não pediu.

O `/luke-voice setup` faz o mesmo que a etapa 6 do instalador, de dentro do Claude Code. Com o luke-voice ligado, o hub prepara a voz em segundo plano e o `/luke-voice status` mostra o progresso. Com ele desligado, o setup roda direto (até 10 minutos por execução; um download cortado continua na próxima vez).

### Um cérebro mais rápido

O cérebro (Ceci, Luke ou Nara) é o Claude Sonnet 5.5, chamado direto pelo `$.model.complete` do motor de mods, com esforço médio e prompt em cache. A chamada `claude -p` ficou só como plano B. Os turnos do cérebro medidos levam cerca de 2 a 3 s (o Claude Haiku 5.5 com esforço baixo, o cérebro até a 0.10.9, levava cerca de 1,2 a 2,1 s).

Algumas coisas não precisam de chamada ao modelo:
- "pare" ou "para" para o Claude, com ou sem o nome dela e quantas vezes você disser ("Para, Ceci, para!", "chega, Ceci").
- Quando a Ceci pergunta "ok?", um "sim" simples roda a ação pendente na hora, e um "não" simples cancela.
- Quando o cérebro demora mais de 600 ms, a Ceci diz um reconhecimento curto: um "Entendi." rápido depois de uma frase curta, e uma frase de escuta como "Deixa eu entender o que você está falando." depois de uma longa, nunca a mesma duas vezes seguidas (`window/engines/acks.js`). Eles são gerados uma vez por janela, só enquanto ninguém fala, então nunca atrasam a primeira resposta dela.
- No perfil gpu, um roteador local responde conversa rápida (cumprimentos, agradecimentos, despedidas, "quem é você", a idade dela, quem a criou) em cerca de 0,3 s, com frases escritas em `hub/router.mjs`, então ele nunca inventa nada. Todo o resto, e qualquer pedido, vai para o Claude Sonnet. Uma checagem de palavras por cima do modelo pequeno garante que um pedido nunca seja respondido localmente (0 de 49 pedidos de teste foram).

### Saber quando você terminou de falar

O Silero VAD (MIT) descarta sons sem fala. O Pipecat Smart Turn v3.2 (BSD-2-Clause) decide quando você terminou de falar: ele é consultado depois de uma pausa de 0,4 s e de novo a cada 0,2 s enquanto a pausa continua, e um "terminou" encerra a sua vez ali. 1,1 s de silêncio sempre encerra (1,3 s sem o modelo). Se uma respiração no meio da frase encerrar a sua vez e você continuar falando antes de a Ceci começar a responder, as duas partes viram um pedido só. Enquanto a Ceci fala, um som que pode ser você falando por cima abaixa a voz dela; ela para quando as suas palavras são ouvidas, e volta ao volume normal se era só o eco dela mesma. Um barulho que começa e continua (uma TV, um ar-condicionado) vira o som da sala em cerca de 10 s, então a sua vez continua terminando na hora.

### Quão rápido é

Medido numa RTX 3060 Ti, perfil gpu:
- primeiro áudio de uma resposta: 0,74 a 0,94 s;
- transcrição: cerca de 0,25 s;
- fim do turno: cerca de 0,18 s;
- "sim" depois de "ok?" até "Comecei": cerca de 0,7 s.

A Ceci fala uma resposta frase por frase, cortada em cada vírgula. Ela começa assim que a primeira frase fica pronta, e a frase seguinte é feita enquanto ela fala; ela não espera mais o áudio pronto cobrir a resposta inteira, o que levava até 17 s numa resposta longa. O silêncio da própria voz em volta de cada trecho é cortado, e a janela põe uma pausa fixa depois dele: 0,15 s depois de uma vírgula, 0,3 s depois do fim de uma frase (. ! ?) e 0,4 s depois de "…". O silêncio da própria voz no fim de uma frase era de 0,42 s em média e chegava a cerca de 1 s.

A voz foi escolhida pelo dono, ouvindo:
- Uma voz anterior, desenhada com o Qwen3-TTS VoiceDesign, foi bem em juízes automáticos, mas o dono ouviu sotaque de Portugal nela. O classificador de sotaque usado na época também chamava de europeias algumas gravações brasileiras reais, então deixou de ser usado como juiz.
- Agora a Ceci clona uma locutora brasileira real: um trecho do banco CML-TTS em português (veja os Créditos).
- Escolha quem responde em **Configurações**, na janela da chamada: Ceci, Luke ou João. Luke e João são vozes masculinas, e o nome, as falas e as saudações do assistente mudam junto. A escolha fica salva e vale a partir da próxima chamada, na voz natural e na leve (a ElevenLabs continua com a Ceci).
- Crie as suas próprias vozes com a skill [luke-voice-studio](https://github.com/lukeware-hub/luke-voice-studio): a partir de um arquivo `.wav`, ela cria uma voz com nome, idade e personalidade, guardada em `~/.luke-voice/voices/<id>/` (uma atualização nunca apaga) e listada em **Configurações** junto com Ceci, Luke e João. Uma pasta chamada `ceci`, `luke` ou `joao` troca o trecho dessa voz só neste computador.
- O trecho foi deixado mais alegre (um pouco mais agudo, com mais melodia e 8% mais rápido), porque a leitura original soava sonolenta.
- O dono comparou as candidatas de ouvido e escolheu esta.

Desde a 0.10.0 a voz é o modelo 1.7B, que o dono ouviu como claramente melhor que o 0.6B. Em 40 frases em pt-BR pelo caminho de produção:
- nenhuma frase falhou nem entrou em repetição (nenhuma em mais 100 gerações com 5 sementes também);
- os erros de palavras ficaram em 8,9% (os ouvidos de produção), quase todos em palavras técnicas em inglês ("branch", "main") e em números escritos com algarismos.

No começo ela soava robótica, porque o tom quase não variava. Um painel automático (variação de tom e detectores de voz sintética, com gravações reais em pt-BR = 10 e o Kokoro = 3) deu 2,9 de 10 para a variação de tom dela. Com temperatura 0,9 em vez de 0,75, a melodia volta (6,2 de 10; a nota do painel foi de 7,6 para 8,8), e a nota do dono foi de 6 para 8,5.

Palavras técnicas em inglês: a voz fala português, então lê algumas delas com regras do português ("changelog" vira "chão geloso", "cache" vira "caixa"). O `speech-text.js` dá a ela uma grafia própria para 11 delas. 34 palavras ganharam várias grafias cada, ditas em três frases e julgadas pelos ouvidos, depois conferidas em quatro frases novas. Uma grafia só fica quando trouxe a palavra em inglês de volta pelo menos duas vezes a mais nas sete frases. Com 5 sementes em 10 frases, os ouvidos acertaram 79 de 125 termos em inglês com as grafias, contra 63 sem elas. Nenhuma grafia ajudou "main", "README", "branch", "commit", "push" ou "lint", então elas ficam como estão. Na 0.17.3, 60 palavras foram conferidas de novo do mesmo jeito: release, front-end, checkout, pipeline, workflow e payload ganharam uma grafia, e token e rebase voltaram a ser escritas como são, porque assim saíam melhor. "Bom dia!" vai como "Bom dia!!", porque com um ponto de exclamação ela dizia "bem dia" em 3 de 4 sementes e com dois disse certo em 10 de 10.

Números e texto: o `speech-text.js` só corta frases num ponto seguido de espaço, nunca dentro de "5.5", "1.500", "app.js" ou depois de "Sr.". Ele escreve por extenso o que a voz lia errado, cada mudança conferida pelos ouvidos dela contra o texto antigo: dinheiro ("R$ 1.500,00" vira "mil e quinhentos reais"), o feminino das horas ("21h" vira "vinte e uma horas"), durações ("1h30" vira "uma hora e 30 minutos"), datas ("22/11/2026" vira "22 de novembro de 2026"), versões ("Opus 5.5" vira "5 ponto 5"), "Prof." e "p.ex.", e "2 * 3" vira "2 vezes 3". Ele tira emoji e lê "site.com.br" como "site ponto com ponto bê erre". Números comuns ficam em algarismos, que ela lê bem. Frases do dia a dia são cortadas e escritas exatamente como antes (um teste confere 52 delas nas duas vozes).

Perguntas: no português do Brasil, a pergunta de sim ou não sobe no fim, e a pergunta com palavra interrogativa ("o que", "quando") desce, como uma afirmação. A voz costuma terminar as duas retas. Subir o tom depois da geração (da 0.9.3 à 0.9.9) soou robótico para o dono. Cerca de 1 em 4 gerações do próprio modelo termina com a subida natural, e o dono deu 8,5 de 10 para a melhor entre 4 gerações. Cada geração leva cerca de 1 s e o motor faz uma por vez, então o hub (`hub/question-pick.mjs`) só faz gerações extras num tempo em que ninguém espera:
- enquanto a frase antes da pergunta ainda toca (a janela diz quanto falta);
- em segundo plano, com o motor parado, começando pelas perguntas que a Ceci mais faz. Qualquer fala de verdade interrompe na hora.

A melhor geração de cada pergunta fica guardada em disco (`~/.luke-voice/cache/questions`) e sai na hora da próxima vez. Em 7 perguntas, nenhuma esperou mais do que antes. 2 de 7 subiram naturalmente na primeira vez, e 7 de 7 depois de um minuto parado. `?voice-question=0` desliga.

### Trocar a voz

Escolha de qualquer um destes jeitos; vale a escolha mais recente:
- `/luke-voice voz local` ou `/luke-voice voz elevenlabs` no Claude Code (vale a partir da próxima chamada);
- o instalador;
- `/plugin configure luke-voice@luke-voice`, opção **voice_provider**.

Sem nenhuma escolha, o luke-voice usa a ElevenLabs se houver chave salva, e a voz gratuita se não houver.

### Prompt Master, quando instalado

Se o [Prompt Master](https://github.com/lukeware-hub/prompt-master), o plugin da Lukeware Hub que reescreve cada prompt antes de o Claude ler, estiver instalado, o luke-voice passa a exigi-lo: toda vez que o luke-voice liga, ele liga o Prompt Master se estiver desligado, e enquanto o luke-voice fica ligado, desligar o Prompt Master (pelo botão ou por `/prompt-master`) o mantém ligado, com um aviso. Sem o Prompt Master, o luke-voice funciona como antes, sem erro.

O luke-voice pergunta ao Claude Code o que está instalado, como o `/plugin` faz: `claude plugin list --json` e `claude plugin marketplace list --json`. Só conta o plugin chamado exatamente `prompt-master`, ativado, instalado para o usuário (ou para este projeto), vindo de um marketplace que aponta para o repositório `lukeware-hub/prompt-master` no GitHub. Um plugin com nome igual ou parecido vindo de qualquer outro lugar, ou uma cópia cuja origem não dá para saber (a biblioteca da organização), não conta. `/luke-voice status` mostra o resultado.

O Prompt Master também reescreve o que você diz à Ceci, em todo prompt que o luke-voice manda por você: o subagente de uma tarefa de voz, uma nota acrescentada ao turno do Claude em andamento e um prompt que começa um turno. O luke-voice põe as suas palavras entre `<user-speech>` e `</user-speech>`, e o Prompt Master reescreve só essas palavras: as linhas do próprio luke-voice em volta delas (planejar antes, onde trabalhar, a resposta em português) ficam como estão. O Prompt Master sempre tira as marcas, também quando está desligado ou a reescrita falha, e aí as suas palavras vão como foram ditas. Sem o Prompt Master, as marcas chegam ao Claude como estão, uma tag dizendo que as palavras dentro são suas. Nenhum prompt pede ao Claude para rodar o Prompt Master: o `/prompt-master` é só o seu botão de ligar e desligar.

### A memória da Ceci

A Ceci nunca esquece uma conversa. Toda chamada fica guardada inteira numa memória só por computador, a mesma para todas as sessões do Claude Code: o que você disse, o que ela disse, as tarefas e os resultados, e o que as sessões fizeram. Ela fica em `~/.ceci/memory.db` (um arquivo SQLite, fora da pasta do luke-voice), é criada sozinha na primeira vez que o luke-voice liga, e nada nela é apagado sozinho.

- **Lembrar:** a cada fala, a Ceci lê um resumo de tudo desde a primeira conversa, as últimas conversas e o que combina com o que você acabou de dizer. Pergunte "lembra da primeira conversa?" ou "o que a gente falou semana passada?" e ela busca na memória.
- **Revisar:** a aba **Memória** da janela da chamada lista todas as conversas por dia, com busca, em páginas de 10, 50 ou 100 (10 por padrão; só a página na tela é carregada); no Claude Code, `/luke-voice memoria` e `/luke-voice memoria buscar <texto>`.
- **Apagar (o único jeito de algo sair):** peça à Ceci ("apaga a conversa de ontem"; ela pergunta "ok?" antes), use os botões **Apagar** da aba Memória, ou `/luke-voice memoria apagar <#conversa | AAAA-MM-DD | AAAA-MM | palavras | tudo>`. Apagar também refaz os resumos que falavam daquilo e compacta o arquivo, para as palavras sumirem do disco. Ao desinstalar, ele pergunta se a memória também deve ser apagada.
- Os resumos são escritos pelo Claude Haiku, na sua conta do Claude, quando não há chamada. As lembranças vão para o cérebro a cada fala, como a conversa já vai.
- **Grafo de conhecimento:** um minuto depois do fim de uma chamada (junto com os resumos), o hub atualiza o grafo do [Graphify](https://github.com/Graphify-Labs/graphify) em segundo plano, no máximo uma vez a cada 10 minutos e nunca durante uma chamada. Ele abre a memória só para leitura, escreve uma transcrição por chamada nova ou que cresceu em `~/.ceci/graph/corpus/` e roda `graphify extract` de forma incremental, então só essas transcrições são lidas de novo; o grafo fica em `~/.ceci/graph/graphify-out/` (`graph.json`, `GRAPH_REPORT.md`, `graph.html`), nunca dentro do banco. Uma chamada apagada da memória sai do corpus na próxima atualização. Precisa do `graphify` no PATH (`pip install graphifyy`) e usa o Claude Code na sua conta (Haiku) por padrão. Ajustes: `CECI_GRAPH=0` desliga, `CECI_GRAPH_MODEL`, `CECI_GRAPH_BACKEND`, `CECI_GRAPHIFY` (o comando), `CECI_GRAPH_HOME` (a pasta). `node hub/graph.mjs` roda uma atualização na mão; `~/.ceci/graph/graph.log` e `state.json` dizem como foi a última.

### O que sai do seu computador

- **Desligado:** nada.
- **Voz gratuita:** o áudio não sai do seu computador. Só o texto do que você falou, um resumo curto do que acontece na sessão e o resultado das tarefas vão para o Claude Sonnet, da sua conta do Claude, que decide o que a Ceci fala. Os arquivos dos modelos são baixados uma vez (do Hugging Face e do GitHub): na instalação ou no setup, ou na primeira chamada se nenhum dos dois rodou. Depois disso, nada é baixado.
- **Voz ElevenLabs:** a sua voz e o que acontece na sessão (seus pedidos e as ferramentas que o Claude usa) vão para o seu agente na ElevenLabs.

## Se algo não funcionar

| O que aparece | O que fazer |
| --- | --- |
| Não ouço nada | Veja se o som do computador está ligado e se a janela mostra **Em chamada**. |
| A voz não foi baixada na instalação | Rode `/luke-voice setup`. Ou comece uma chamada: a primeira chamada baixa a voz, com o progresso na janela. |
| A Ceci usa a voz leve num computador com placa de vídeo | A GPU tem menos de 3,8 GB de memória de vídeo, ou o teste do setup falhou. O `/luke-voice status` mostra o perfil. O `/luke-voice setup` tenta de novo. |
| A Ceci demora alguns segundos para responder | Os pedidos que vão para o Claude Sonnet levam cerca de 2 a 3 segundos. No perfil gpu, a conversa rápida é instantânea. No perfil light, um computador sem placa de vídeo também leva 1 a 2 segundos a mais para ouvir e falar. |
| A voz gratuita ficou mais robótica | Num computador lento, o perfil light troca para o Piper, uma voz mais leve, para não falar travado. **Configurações**, na janela, mostra qual modelo de voz está falando. |
| A voz gratuita soa robótica no Mac | Quando a voz natural é lenta demais para o Mac (como num M1), a assistente fala com a voz do próprio Mac: a voz Siri escolhida como Voz do Sistema em Conteúdo Falado ou, se não houver, uma voz pt-BR Premium ou Melhorada. O instalador pede a **Siri Voz 1** (Ajustes do Sistema › Acessibilidade › Conteúdo Falado › Voz do Sistema); ela baixa uma vez, cerca de 230 MB, e não pela internet do celular (o macOS não baixa vozes numa rede que ele marca como cara). Com a Siri Voz 1 (masculina) a assistente é o **Luke**, um homem de 22 anos que fala de si no masculino; com a Siri Voz 2 (feminina), é a **Nara**, a Ceci com outro nome. Outra voz masculina do Mac também é o Luke; qualquer outra voz é a Ceci. O nome acompanha a voz a partir da próxima chamada. No Windows, no Linux e na ElevenLabs é sempre a Ceci. `LUKE_VOICE_MAC_VOICE=off` desliga, `LUKE_VOICE_MAC_VOICE=<identificador>` escolhe uma voz. |
| "Falta a chave da ElevenLabs" ou "Chave: faltando" | Salve a chave com `/plugin configure luke-voice@luke-voice` (ou rode o instalador de novo) e reinicie o Claude Code. Ou use a voz gratuita: `/luke-voice voz local`. |
| Troquei a chave da ElevenLabs e nada mudou | A chave fica guardada pelo Claude Code (no Mac, no Keychain). Uma chave exportada no `~/.zshrc` não chega a um Claude Code aberto pelo Dock. Salve com `/plugin configure` e reinicie o Claude Code. |
| O microfone não funciona | Na janela da chamada, libere o microfone e toque em **Chamar** de novo. |
| A janela mostra **Hub offline** | Ligue o luke-voice no Claude Code; a janela volta sozinha. |
| ElevenLabs: a chamada parou de conectar | Os minutos grátis do mês podem ter acabado. Veja o seu uso em elevenlabs.io, ou troque para a voz gratuita. |
| A janela continua com o visual antigo | Feche o Claude Code por completo e abra de novo. |
| Instalador: "o Claude Code não foi encontrado" | Faça o passo 1 e rode o instalador de novo. Se acabou de instalar o Claude Code, feche e abra o terminal antes. |
| Instalador: "sem conexão com a internet, ou a rede (um proxy de empresa) bloqueou o download" | Confira a internet. Atrás de um proxy de empresa, defina `HTTPS_PROXY=http://endereço:porta` e rode o instalador de novo (no Windows ele também usa o proxy configurado no Windows). |
| Instalador: "Falta espaço: a voz precisa de X GB livres" | Libere esse espaço no disco que a mensagem diz e rode o instalador de novo; o download continua de onde parou. |
| "Node.js não encontrado" | Feche e abra o terminal (ou o Claude Code) de novo. Se repetir, rode o instalador de novo. |
| "Não consegui abrir a janela da chamada" | Nenhum Chrome, Chromium ou Edge foi encontrado. Abra num navegador o endereço que a mensagem mostra, ou instale o Google Chrome. |
| Qualquer outra coisa | Digite `/luke-voice status` e mande o resultado para quem cuida do luke-voice. |

## Desinstalar

Uma linha remove tudo: o luke-voice do Claude Code, a voz baixada, e o Node.js e o Git que o instalador trouxe (e tira os dois do PATH). Ela pergunta antes de começar e pede para fechar o Claude Code antes (aberto, ele ligaria o luke-voice de novo); o resto do computador não muda. A memória da Ceci (`~/.ceci`) fica, a menos que você diga para apagar também: o desinstalador pergunta, e no Claude Code você escolhe `/luke-voice uninstall confirmar manter-memoria` ou `/luke-voice uninstall confirmar apagar-memoria`.

De dentro do Claude Code (macOS ou Linux): digite `/luke-voice uninstall`. Ele diz o que vai ser apagado e pede `/luke-voice uninstall confirmar`; aí encerra a chamada, desliga o luke-voice e roda o desinstalador abaixo em segundo plano. Depois, feche o Claude Code e abra de novo. No Windows, ele mostra a linha abaixo para colar.

- **Windows:** aperte **Windows + R**, cole esta linha e aperte **Enter**:

  ```
  powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall-luke-voice-windows.cmd | iex"
  ```

- **macOS / Linux:** cole isto no Terminal:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall.sh | bash
  ```

  Sem curl: `wget -qO- https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall.sh | bash`.

Para remover só o plugin e manter a voz: no Claude Code, digite `/plugin`, escolha **luke-voice** e **Uninstall**.

## Comandos do plugin (Claude Code)

O luke-voice é um plugin do Claude Code chamado `luke-voice@luke-voice`. O instalador roda estes comandos por você; rode-os num terminal para instalar, atualizar ou remover à mão. Feche e abra o Claude Code depois de cada um: `/reload-plugins` não basta.

| Tarefa | Comando |
| --- | --- |
| Adicionar o marketplace | `claude plugin marketplace add lukeware-hub/luke-voice` |
| Instalar | `claude plugin install luke-voice@luke-voice` |
| Ver se está instalado e ligado | `claude plugin list --json` |
| Atualizar (atualize o marketplace primeiro) | `claude plugin marketplace update luke-voice` e depois `claude plugin update luke-voice@luke-voice` |
| Desligar ou ligar | `claude plugin disable luke-voice@luke-voice` ou `claude plugin enable luke-voice@luke-voice` |
| Remover só o plugin | `claude plugin uninstall luke-voice@luke-voice` |
| Remover também o marketplace | `claude plugin marketplace remove luke-voice` |
| Escolher a voz gratuita | `printf '{"voice_provider":"local"}' \| claude plugin configure luke-voice@luke-voice --values-stdin` |
| Escolher a ElevenLabs | `printf '{"voice_provider":"elevenlabs","api_key":"%s"}' "$ELEVENLABS_API_KEY" \| claude plugin configure luke-voice@luke-voice --values-stdin` |

De dentro do Claude Code, o `/luke-voice update` faz a atualização por você. O `/plugin` abre o mesmo menu (escolha **luke-voice** e depois atualizar ou **Uninstall**), e o `/plugin configure luke-voice@luke-voice` salva as opções. Depois de instalar ou atualizar à mão, rode `/luke-voice setup` para baixar a voz gratuita. O `claude plugin uninstall` mantém a voz baixada; as linhas de desinstalação acima removem tudo.

## Como funciona

A janela da chamada fala com o hub (`hub/server.mjs`, em 127.0.0.1:4848). Na voz gratuita há dois caminhos:
- **Navegador (perfil light):** microfone, detector de voz, Whisper, `POST /brain`, Kokoro (ou Piper) para falar.
- **Motor nativo (perfil gpu):** microfone, Silero VAD e Smart Turn, depois o hub (`/stt`, `/tts`, `/route`) e os `llama-server` locais: Qwen3-ASR (ouvidos), Qwen3-TTS (voz) e Qwen3.5 0.8B (roteador). Os pedidos vão para o `/brain`.

O hub serve todos os arquivos de modelo a partir de `~/.luke-voice/models`, fixados por revisão do Hugging Face e sha256 (a voz Qwen3-TTS 1.7B e o projetor convertidos, e o Qwen3-ASR em Q6, vêm do prerelease `voice-models-v2` deste repositório no GitHub). A janela da chamada não baixa nada do Hugging Face. O manifesto é o `hub/models.mjs`; o manifesto e o motor do llama.cpp ficam em `hub/engine.mjs`; o `hub/setup.mjs` é o CLI de setup; o `hub/router.mjs` é o roteador.

## Segurança

- Os binários do llama.cpp são arquivos oficiais de release do GitHub, fixados por sha256.
- Todo arquivo de modelo é fixado por revisão e sha256 e conferido antes do uso.
- Os servidores nativos escutam só em 127.0.0.1, em portas aleatórias.
- O `/stt`, o `/tts` e o `/route` do hub exigem a chave da janela.
- A chave da janela nunca vai na linha de comando, onde outros usuários do computador poderiam lê-la. O hub abre a janela com um código de uso único que expira em dois minutos (quinze quando o usuário precisa abrir o endereço à mão). A janela troca o código pela chave uma vez, guarda a chave no sessionStorage da aba para que recarregar continue funcionando, e tira o código da barra de endereço.
- Os arquivos de modelo e de terceiros (`/models/`, `/vendor/`) disparam downloads grandes, então só são servidos para a janela: `Sec-Fetch-Site` da mesma origem, ou, num navegador que não o envia, o endereço da própria janela como `Origin` ou `Referer`, ou a chave da janela.

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
- Qwen3-TTS 1.7B Base, Qwen3-ASR 0.6B e Qwen3.5 0.8B: Apache-2.0.
- Pipecat Smart Turn v3.2: BSD-2-Clause.
- Silero VAD: MIT.
- Kokoro-82M: Apache-2.0.
- Whisper: MIT.
- transformers.js e onnxruntime-web: Apache-2.0 e MIT.
- A voz do Piper: veja o cartão do modelo.
- espeak-ng (pelo espeak-phonemizer): GPL-3.0.

O trecho de voz de referência da Ceci, `agent/ceci-voice.wav`, foi fornecido pelo dono do projeto, cortado e abaixado 1,5 semitom.

Os trechos de voz de referência do Luke e do João, `agent/luke-voice.wav` e `agent/joao-voice.wav`, foram fornecidos pelo dono do projeto, cortados e abaixados 1,5 semitom. Na voz leve, Luke e João falam com as vozes `pm_alex` e `pm_santa` do Kokoro.

Mais detalhes, em inglês, no [README.md](README.md).
