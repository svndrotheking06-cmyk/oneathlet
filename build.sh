#!/bin/sh
# Construit index.html (version web) à partir de la page source : ajoute l'en-tête HTML et le chat Crisp.
# Usage : ./build.sh chemin/vers/page-source.html
set -e
SRC="$1"
{
cat <<'HEAD'
<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
<script>window.$crisp=[];window.CRISP_WEBSITE_ID="cd6458ad-9fbc-4c15-ac46-5e59de690163";window.CRISP_RUNTIME_CONFIG={locale:"fr"};(function(){var d=document,s=d.createElement("script");s.src="https://client.crisp.chat/l.js";s.async=1;d.getElementsByTagName("head")[0].appendChild(s);})();</script>
</head>
<body>
HEAD
cat "$SRC"
printf '\n</body>\n</html>\n'
} > index.html
