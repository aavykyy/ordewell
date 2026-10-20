import { describe, it, expect } from 'vitest';
import { effectRuleFor, parseEffectAllowlist } from '../effectAllowlist';
import { DEFAULT_PLANNER_ALLOWLIST } from '../plannerAllowlist';

/**
 * The effect allowlist (ADR-0035): a rule pre-approves a script task only when
 * it names every word of every command the task runs.
 */
const commands = (...lines: string[]) => ({ commands: lines.map((line) => line.split(' ')), timeoutMs: 600_000 });
const ruleFor = (entries: string[], ...lines: string[]) => effectRuleFor(parseEffectAllowlist(entries), commands(...lines));

describe('the effect allowlist', () => {
  it('covers a command its rule names word for word, `*` standing for one word or a run inside one', () => {
    expect(ruleFor(['git push origin feature/*'], 'git push origin feature/login')).toBe('git push origin feature/*');
    expect(ruleFor(['gh pr merge * --squash'], 'gh pr merge 57 --squash')).toBe('gh pr merge * --squash');
    expect(ruleFor(['make release'], 'make release')).toBe('make release');
    expect(ruleFor(
      ['az webapp config appsettings set --resource-group dev --name * --settings *'],
      'az webapp config appsettings set --resource-group dev --name api --settings LOG_LEVEL=debug',
    )).toBe('az webapp config appsettings set --resource-group dev --name * --settings *');
  });

  it('covers only the exact command: not with an extra flag, not a missing word, not a sibling verb', () => {
    const rules = ['git push origin feature/*'];
    expect(ruleFor(rules, 'git push origin feature/login --force')).toBeNull();
    expect(ruleFor(rules, 'git push --force origin feature/login')).toBeNull();
    expect(ruleFor(rules, 'git push origin')).toBeNull();
    expect(ruleFor(rules, 'git pull origin feature/login')).toBeNull();
    expect(ruleFor(rules, 'git push upstream feature/login')).toBeNull();
    expect(ruleFor(['gh pr merge *'], 'gh pr close 57')).toBeNull();
    expect(ruleFor(['gh pr merge *'], 'gh pr merge 57 --admin')).toBeNull();
  });

  it('never lets a `*` stand for a flag: flags change what an effect does, so a rule writes each one', () => {
    expect(ruleFor(['git push origin *'], 'git push origin --delete')).toBeNull();
    expect(ruleFor(['git push origin *'], 'git push origin main')).toBe('git push origin *');
    expect(ruleFor(['kubectl scale deployment/api --replicas=*'], 'kubectl scale deployment/api --replicas=3')).toBe('kubectl scale deployment/api --replicas=*');
  });

  it('never covers a script body, whatever its text', () => {
    expect(effectRuleFor(parseEffectAllowlist(['git push origin main']), { script: 'git push origin main', timeoutMs: 600_000 })).toBeNull();
  });

  it('never covers a program named by its path, and ignores a rule that names one', () => {
    expect(ruleFor(['deploy prod'], './deploy prod')).toBeNull();
    expect(ruleFor(['deploy prod'], 'bin/deploy prod')).toBeNull();
    expect(ruleFor(['deploy prod'], '/usr/local/bin/deploy prod')).toBeNull();

    const list = parseEffectAllowlist(['./bin/deploy', 'bin/deploy', '/usr/local/bin/x']);
    expect(list.rules).toEqual([]);
    expect(list.ignored.map((i) => i.rule)).toEqual(['./bin/deploy', 'bin/deploy', '/usr/local/bin/x']);
    expect(effectRuleFor(list, commands('./bin/deploy'))).toBeNull();
  });

  it('needs every command of a multi-command body covered, and names each rule that did', () => {
    const rules = ['git push origin feature/*', 'gh pr create --fill'];
    expect(ruleFor(rules, 'git push origin feature/login', 'gh pr create --fill')).toBe('git push origin feature/* + gh pr create --fill');
    expect(ruleFor(rules, 'git push origin feature/login', 'git push origin feature/signup')).toBe('git push origin feature/*');
    expect(ruleFor(rules, 'git push origin feature/login', 'gh pr merge 57')).toBeNull();
    expect(ruleFor(rules, 'gh pr create --fill', 'rm -rf build')).toBeNull();
  });

  it('lets a `!` exclusion win, from the planner allowlist in force or written among the effect rules', () => {
    const fromPlanner = parseEffectAllowlist(['kubectl delete pod *'], ['gh issue list', '!kubectl *system*']);
    expect(effectRuleFor(fromPlanner, commands('kubectl delete pod api-1'))).toBe('kubectl delete pod *');
    expect(effectRuleFor(fromPlanner, commands('kubectl delete pod kube-system-dns'))).toBeNull();

    const own = parseEffectAllowlist(['git push origin *', '!git push origin main']);
    expect(effectRuleFor(own, commands('git push origin feature'))).toBe('git push origin *');
    expect(effectRuleFor(own, commands('git push origin main'))).toBeNull();
  });

  it('keeps the built-in planner exclusions when the defaults are on', () => {
    const list = parseEffectAllowlist(['kubectl delete * --kubeconfig=*'], DEFAULT_PLANNER_ALLOWLIST);
    expect(effectRuleFor(list, commands('kubectl delete pod --kubeconfig=/tmp/other'))).toBeNull();
  });

  it('ignores a rule that does not name its operation before any `*`, with a warning that says why', () => {
    const list = parseEffectAllowlist(['az webapp config * set', '* push', 'git * origin main', 'gcloud compute instances * --zone x', 'git push origin feature/*']);
    expect(list.rules.map((r) => r.text)).toEqual(['git push origin feature/*']);
    expect(list.ignored.map((i) => i.rule)).toEqual(['az webapp config * set', '* push', 'git * origin main', 'gcloud compute instances * --zone x']);
    expect(list.ignored[0].warning).toBe('Ignored the effect allowlist rule "az webapp config * set": a rule spells out its operation, up to and including the verb, before any *.');
    expect(ruleFor(['az webapp config * set'], 'az webapp config appsettings set')).toBeNull();
  });

  it('reads a verb in its CLI\'s own spelling: a suffix, or after a `:`', () => {
    const list = parseEffectAllowlist(['aws ec2 terminate-instances --instance-ids *', 'heroku config:set *', 'kubectl cordon *']);
    expect(list.ignored).toEqual([]);
    expect(effectRuleFor(list, commands('heroku config:set LOG=debug'))).toBe('heroku config:set *');
  });

  it('has no built-in rules: an empty list covers nothing', () => {
    expect(ruleFor([], 'git push origin main')).toBeNull();
    expect(effectRuleFor(parseEffectAllowlist([]), { commands: [], timeoutMs: 600_000 })).toBeNull();
  });
});
