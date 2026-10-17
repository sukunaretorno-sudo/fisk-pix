# 🎓 Fisk Pix — Sistema de Banco & Gestão Escolar Fisk

Sistema completo de economia gamificada e gestão de turmas para a escola **Fisk**, com **dados globais sincronizados**, **segurança**, **painéis dedicados para Alunos, Professores e Coordenação**, **gerador de carteirinhas físicas impressas** e **banco de dados SQLite nativo**.

---

## 🚀 Como Iniciar

1. Abra o terminal na pasta do projeto:
   ```bash
   cd "C:\Users\Windows\Desktop\Fisk pix"
   ```
2. Inicie o servidor:
   ```bash
   npm start
   ```
3. Acesse no navegador:
   ```
   http://localhost:3000
   ```

*(Para acessar pelo celular ou tablet na mesma rede Wi-Fi, basta usar o IP da máquina, ex: `http://192.168.1.X:3000`)*.

---

## 👥 Contas e Níveis de Acesso

| Nível de Acesso | Usuário (Login) | Senha Padrão | Funcionalidades Principais |
| :--- | :--- | :--- | :--- |
| **Coordenação Pedagógica** | `Coordenação` | `Coordenação26@` | Painel master, histórico de auditoria de professores, cadastro de professores, turmas e alunos, emissão de moeda. |
| **Corpo Docente (Professores)** | `teacher` | `teacher123` | Chamada das turmas (+F$ 3), lançamento de méritos/bônus, gerador de cartões físicos para impressão, relatórios Excel. Sem carteira Pix pessoal. |
| **Alunos** | `tyller`, `bia`, `cadu` | `123456` *(cadu: `admin`)* | Carteira de Fisk Dollars, envio/recebimento de Pix por chave ou QR Code, lojinha de molduras VIP, extrato e ranking. |

---

## 🌟 Módulos Implementados

### 1. 🏫 Coordenação Pedagógica & Auditoria dos Professores
- Login exclusivo: `Coordenação` com a senha `Coordenação26@`.
- **Auditoria dos Professores:** Registro em tempo real de todas as ações pedagógicas e financeiras dos professores (chamadas feitas, presença, estornos, premiação de méritos, etc.).
- **Gestão de Professores & Turmas:** Cadastra novos professores e vincula a qualquer turma (*Teens*, *Kids*, *Adults*).

### 2. 👩‍🏫 Ambiente Dedicado dos Professores
- Interface puramente pedagógica e administrativa (sem saldo de Pix pessoal).
- **Chamada:** Selecione a turma e a data para marcar presença (+F$ 3) ou falta com 1 clique.
- **Lançar Méritos ⭐:** Conceda Fisk Dollars individuais ou bônus coletivos para a turma inteira por participação, homework ou destaque de conversação.

### 3. 💳 Cartão Fisk Físico Impresso (Ideia 6)
- Gere e imprima carteirinhas de identificação dos alunos no formato de cartão de crédito (CR80).
- Cada cartão contém:
  - Nome do Aluno e `@username`.
  - Turma e nível (*Teens 1 · Intermediário*).
  - Foto do Buddy com a moldura equipada pelo aluno.
  - QR Code Pix oficial de alta resolução para leitura instantânea por outros celulares.
  - Código serial de autenticação.
  - Botão com suporte a impressão direta (`window.print()`) formatado para folha A4.

### 4. 🖼️ Lojinha Virtual da Fisk (Apenas Molduras de Perfil)
- Vitrine de molduras VIP animadas para o avatar do Buddy:
  - 🥇 *Moldura Dourada VIP* (F$ 30)
  - ⭐ *Moldura Stars & Stripes* (F$ 35)
  - 🔥 *Moldura On Fire* (F$ 45)
  - ⚡ *Moldura Cyber Neon* (F$ 50)
  - 👑 *Coroa Real English Master* (F$ 75)
  - 💎 *Moldura Diamante Fisk* (F$ 100)
- O aluno pode visualizar o preview no Buddy antes de comprar, equipar e desequipar a qualquer momento.

### 5. 📱 QR Code Pix & Chaves Pessoais
- Chave no formato `@apelido`.
- Aba *"Meu QR Code"* para receber pagamentos diretamente pela tela do celular.

### 6. 📊 Exportação para Microsoft Excel (.csv)
- Botões de exportação com suporte nativo a acentuação em português (UTF-8 BOM) para a chamada de frequência e extrato financeiro geral.
