# build-tools

Ferramentas de build para este fork. O `Dockerfile` na raiz do projeto continua
sendo o processo oficial; o que está aqui existe por dois motivos: registrar uma
descoberta que bloqueia o build, e permitir um ciclo de iteração rápido.

---

## O `--ulimit` é obrigatório

O `Dockerfile` da raiz **falha** com uma mensagem enganosa:

```
/bin/sh: 1: tizen: not found
```

A causa não é o `tizen` CLI estar fora do PATH nem faltar JDK. O instalador do
Tizen Studio **traz o próprio JDK embutido** (em `~/.package-manager/jdk`), mas
essa JVM aborta durante a instalação:

```
setting up jdk at /home/moonlight/.package-manager/jdk
library initialization failed - unable to allocate file descriptor table - out of memory
./installer.sh: line 19: 54 Aborted (core dumped) ".../jdk/bin/java" -jar installer.jar
```

O instalador então **sai com código 0** sem ter instalado nada — por isso o passo
seguinte é que quebra, e com uma mensagem que aponta para o lugar errado.

É o comportamento clássico de JVM antiga em container quando `RLIMIT_NOFILE` é
muito alto: a JVM tenta alocar uma tabela de descritores proporcional ao limite.
O BuildKit roda os passos com um limite altíssimo; o `docker run` normal usa 1024
e por isso o mesmo instalador funciona lá.

**Solução — passar o limite explicitamente no build:**

```bash
docker build --ulimit nofile=1024:524288 -t moonlight-tizen .
```

Isso não exige nenhuma alteração no `Dockerfile`.

> Verificado: o instalador conclui e gera `tizen-studio/tools/ide/bin/tizen`.
> Ainda **não** foi testado um build completo de ponta a ponta com o `Dockerfile`
> da raiz + `--ulimit`; o `.wgt` existente foi produzido pelo caminho em dois
> estágios descrito abaixo.

---

## Ciclo rápido em dois estágios

O `Dockerfile` da raiz baixa o SDK Emscripten (~1 GB) e o Tizen Studio (~280 MB)
na mesma cadeia de camadas, então qualquer mudança em código invalida tudo.
Separar compilação de empacotamento evita isso.

**1. Compilar e linkar** (valida todo o C/C++, sem Tizen Studio):

```bash
docker build -f build-tools/Dockerfile.buildonly -t moonlight-wasm-check .
```

**2. Empacotar e assinar** (parte da imagem acima):

```bash
docker build --ulimit nofile=1024:524288 \
  -f build-tools/Dockerfile.package -t moonlight-wgt .
```

**3. Extrair o `.wgt`:**

```bash
CID=$(docker create moonlight-wgt)
docker cp "$CID:/home/moonlight/$(docker run --rm moonlight-wgt sh -c 'ls -1 /home/moonlight/*.wgt | xargs -n1 basename')" .
docker rm "$CID"
```

O nome do arquivo é montado no build a partir da versão declarada em `config.xml`
e da variante — `Moonlight-v<versão>-samirmartins[-ForceGM].wgt` — por isso a
receita descobre o nome em vez de fixá-lo.

Durante iteração em código, só o passo 1 precisa rodar — ele é o que pega erro de
compilação e link.

---

## A variante ForceGM

O upstream publica dois widgets a cada release, **construídos do mesmo código**. A
única diferença é uma linha em `config.xml`:

```xml
<tizen:metadata key="http://samsung.com/tv/metadata/use.game.mode" value="true"/>
```

Ela pede ao firmware da TV que coloque o **painel** em Game Mode enquanto o app
roda. Morou em `res/config.xml` até `ac6ba96` (dez/2024), que a removeu por
travar o app em Tizen mais novo; desde então é download separado.

**Não confundir com o interruptor "Game Mode" dentro do app**, que escolhe o modo
de latência `kUltraLow` do EMSS (`wasm/main.cpp:371`). São coisas independentes, e
é o interruptor — não a metadata — que quebra no Tizen 9.0. Nesta variante o
interruptor deve ficar **desligado**: aí o decoder usa `kLow`, que é estável, e o
painel entra em Game Mode pela metadata.

Para construir, basta o `--build-arg` no passo 2; o resto é idêntico e o cache das
camadas é reaproveitado inteiro:

```bash
docker build --ulimit nofile=1024:524288 --build-arg FORCE_GAME_MODE=1 \
  -f build-tools/Dockerfile.package -t moonlight-wgt-forcegm .
```

O mesmo `--build-arg` funciona no `Dockerfile` da raiz, se você preferir o caminho
oficial em uma etapa só.

Os dois widgets têm o **mesmo** `tizen:application id` e `package`, como no
upstream: instalar um substitui o outro, e as configurações salvas são
preservadas. Voltar atrás é reinstalar o outro `.wgt`.

---

## Notas

- O `openjdk-17-jdk-headless` instalado em `Dockerfile.package` acabou sendo
  **desnecessário** (o instalador traz o próprio JDK). Foi mantido porque a
  receita foi validada com ele presente; remover é seguro em princípio, mas não
  foi testado.
- O `.wgt` é assinado com o certificado de teste do projeto (perfil `Moonlight`,
  senha `123456`), igual às releases oficiais.
- Os placeholders `__BUILD_TYPE__` / `__BUILD_COMMIT__` em
  `wasm/platform/index.js` são substituídos pelo workflow de CI, não pelo build
  local. Em build local eles ficam literais, o que só afeta a string de versão
  exibida na tela de System Info.
