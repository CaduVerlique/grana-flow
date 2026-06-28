# GranaFlow

App pessoal para acompanhar gastos, limites mensais, projeções e investimentos a partir de dados financeiros importados.

## Stack

- Vite
- React
- TypeScript
- Tailwind CSS
- Lucide React

## Comandos

```bash
npm install
npm run dev
npm run build
npm run lint
```

## Pluggy

Crie um `.env.local` usando `.env.example` como base:

```bash
PLUGGY_CLIENT_ID=
PLUGGY_CLIENT_SECRET=
PLUGGY_ITEM_ID=
API_PORT=8787
```

O frontend chama `/api/pluggy/snapshot` para a visão mensal e `/api/pluggy/annual?year=YYYY` para a visão anual. O backend local conversa com a Pluggy, então o `clientSecret` fica fora do bundle do navegador.

## MVP

1. Dashboard mensal com dados reais da Pluggy.
2. Limite mensal ajustável.
3. Categorias e transações normalizadas.
4. Projeção do gasto mensal.
5. Visão anual com gastos, aportes, metas mensais e projeção até dezembro.
6. Próximo passo: persistir snapshots localmente para histórico.

## Visão anual

A aba `Ano` mostra os 12 meses do ano selecionado com:

- gasto real ou comprometido por mês;
- aporte líquido em investimentos, considerando aportes menos resgates;
- metas editáveis de gasto e investimento para cada mês;
- totais do período, saldo líquido atual e projeção de saldo até dezembro.

As metas são salvas localmente no navegador com `localStorage`. Meses futuros usam a meta preenchida; se ela estiver vazia, usam a média real do ano. Parcelas futuras já conhecidas entram como gasto comprometido mínimo.

## Regra atual de orçamento

O gasto do mês considera compras no cartão e débitos da conta que parecem despesas reais.

Ficam fora do orçamento:

- aportes e resgates de investimentos;
- pagamentos de fatura;
- estornos/créditos do cartão.

Transferências negativas entram no orçamento, porque podem ser pagamentos por Pix/TED. A exceção é pagamento de fatura do cartão, que fica fora para não duplicar compras já contabilizadas no crédito.

Investimentos são exibidos pelo saldo da carteira retornado pela Pluggy, não pelo fluxo de transações do mês.

Compras em moeda estrangeira usam o valor `amountInAccountCurrency` quando a Pluggy informa a conversão para BRL. Se esse campo não vier, o backend tenta converter pela PTAX do Banco Central na data da compra.
