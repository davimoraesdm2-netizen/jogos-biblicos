# Jogos Bíblicos ao Vivo

Três jogos multiplayer em tempo real: Quiz Bíblico, Quem sou eu? e Impostor.

## Rodar localmente

Requer Node.js 18 ou superior.

```bash
npm install
npm start
```

- Jogadores: http://localhost:3000
- Anfitrião: http://localhost:3000/host

## Publicar no Render

1. Envie o conteúdo desta pasta para um repositório GitHub.
2. No Render, crie um **Web Service** conectado ao repositório.
3. O arquivo `render.yaml` já define `npm ci` e `npm start`; confirme o plano e publique.
4. Use a URL pública gerada pelo Render. O anfitrião abre `https://SUA-URL/host` e os jogadores abrem a URL principal.

O serviço precisa manter conexões WebSocket. Não publique como site estático. O plano gratuito pode suspender o serviço após inatividade, então abra a página do anfitrião alguns minutos antes de jogar.

## Conteúdo

- `questions.json`: perguntas do Quiz Bíblico.
- `quemsou.json`: personagens e cinco dicas para cada um.
- `impostor.json`: categorias e palavras do Impostor.
- `public/`: páginas e estilos do anfitrião e dos jogadores.

## Observação de operação

As salas e pontuações ficam em memória no processo. Reiniciar ou suspender o servidor encerra as salas em andamento. Para partidas ao vivo, mantenha o anfitrião conectado durante toda a sessão.
