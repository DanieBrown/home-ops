# Legal Disclaimer & Acceptable Use

## 1. Nature of the Project

`home-ops` is a collection of Markdown prompts, Node.js scripts, and local dashboard utilities. It is a local execution tool. The maintainers do not host, deploy, or operate an AI system, and they do not provide direct API access to large language models.

Users download the code, run it on their own machines, and connect it to their own AI provider (Anthropic, OpenAI, or any other). The maintainers have no visibility into, control over, or responsibility for how the tool is used after download.

## 2. Data Privacy (GDPR)

The maintainers do not act as a Data Controller or Data Processor under GDPR or any other data protection regulation.

- All personally identifiable information you input, such as buyer details, saved listing notes, and portal login state, is processed locally on your machine.
- When you use an AI CLI tool (Claude Code, Codex, OpenCode), your data is sent directly to the AI provider you chose. Review their privacy policies.
- We do not collect analytics, telemetry, or usage data of any kind.
- API keys, credentials, and personal files are gitignored by default. Never commit them to a public fork.

## 3. AI Model Behavior

This tool interfaces with AI models via third-party CLI tools. The maintainers do not control these models and cannot guarantee their behavior.

- **Hallucinations:** AI models may fabricate listing facts, school details, neighborhood claims, or pricing context. You must verify critical facts before acting.
- **Safety guardrails:** The default prompts instruct the AI not to contact agents, schedule tours, or submit offers without human review. AI compliance is not guaranteed. If you change the prompts or override the safeguards, you accept responsibility for the results.
- **Evaluation accuracy:** Listing scores and recommendations are AI-generated decision support, not legal, financial, or real-estate advice.

## 4. Third-Party Platforms

Home-ops may interact with listing portals, map products, school sites, public planning systems, and local news pages.

- Users must comply with the Terms of Service of every platform they interact with.
- Do not use this tool to scrape platforms that prohibit automated access.
- Do not use this tool to bypass authentication, harvest private data, or overwhelm public sites with automated traffic.
- Any consequences from ToS violations — including IP bans, account restrictions, or legal action from platforms — are solely the responsibility of the user.
- The maintainers actively reject contributions that facilitate ToS violations (see CONTRIBUTING.md).

## 5. Acceptable Use

Home-ops is designed to help individuals make better home-search decisions, not to automate away human judgment. Acceptable use includes:

- Evaluating listings against explicit buyer criteria
- Researching schools, neighborhoods, and development risk
- Scanning configured portal searches for fresh listings
- Tracking decision status in a local markdown workflow

Unacceptable use includes:

- Contacting agents, scheduling tours, or submitting offers without human review
- Scraping platforms that prohibit automated access
- Acting on AI-generated claims without verifying them
- Using the tool to discriminate unlawfully or make deceptive representations

## 6. EU AI Act

Because this tool runs locally, is free, and is open-source, the maintainers are not placing an AI system on the market or putting one into service under the EU AI Act. Users who deploy the tool in a commercial or organizational context should assess their own obligations under the AI Act.

## 7. Indemnification

By using home-ops, you agree to indemnify, defend, and hold harmless the authors, contributors, and any affiliated parties from and against any claims, damages, losses, liabilities, costs, and expenses arising from your use of this software, your violation of these terms, or your violation of any third-party terms of service.

## 8. Cost Responsibility

If you use paid AI providers (Anthropic API, OpenAI API, etc.), you are solely responsible for monitoring and managing your own token usage and associated costs. The maintainers are not responsible for unexpected charges.

## 9. MIT License

As stated in the [LICENSE](LICENSE) file:

> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## 10. Changes

This disclaimer may be updated as the project evolves. Users are encouraged to review it periodically.
