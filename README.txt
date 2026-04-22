DISCLOUD - O QUE UPAR

Arquivos desta pasta:
- multiplayer-server.mjs
- package.json

Passos:
1) Upe esta pasta no seu app Node da Discloud.
2) Rode npm install (se a plataforma nao instalar automaticamente).
3) Start command: npm start
4) Garanta que a plataforma exponha WebSocket publico (WSS).
5) Copie a URL final WSS (exemplo: wss://seu-app.discloud.app).

Variavel importante:
- PORT: deixe a Discloud definir automaticamente.
- PUBLIC_WS_URL: coloque a URL publica WSS do app para o servidor imprimir no log a linha pronta para Vercel.

Exemplo:
- PUBLIC_WS_URL=wss://seu-app.discloud.app

Se quiser forcar localmente:
- PORT=8787 npm start
