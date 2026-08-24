/* ============================================================
   JudiX API — Supabase 연결 계층

   모든 화면이 이 파일 하나로 DB에 접근한다.
   페이지 스크립트는 반드시 JudiX.ready 를 기다린 뒤 호출할 것.

     JudiX.ready.then(async (api) => {
       const me = await api.requireRole('judge');
       ...
     });

   접근 제어는 프론트가 아니라 DB의 RLS가 강제한다.
   여기서 걸러내는 것은 화면 흐름을 위한 것일 뿐이다.
   ============================================================ */
window.JudiX = (function () {
  'use strict';

  var SUPABASE_URL = 'https://zpmogtbnctypspxlteit.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_L-nRhOs2otZjN1udPO3pmQ_u8GzjK5l';

  var sb = null;
  var _me = null;

  var api = {};

  /* ---------- 인증 ---------- */

  api.signIn = async function (email, password) {
    var res = await sb.auth.signInWithPassword({ email: email, password: password });
    if (res.error) throw res.error;
    _me = null;
    return res.data;
  };

  api.signUp = async function (email, password, meta) {
    var res = await sb.auth.signUp({
      email: email, password: password, options: { data: meta || {} }
    });
    if (res.error) throw res.error;
    _me = null;
    return res.data;
  };

  api.signOut = async function () {
    await sb.auth.signOut();
    _me = null;
  };

  /** 현재 로그인 사용자 + 프로필. 미로그인이면 null */
  api.me = async function () {
    if (_me) return _me;
    var s = await sb.auth.getSession();
    var user = s.data.session && s.data.session.user;
    if (!user) return null;
    var p = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (p.error) throw p.error;
    _me = { user: user, profile: p.data };
    return _me;
  };

  var HOME = { judge: 'judge-dashboard.html', applicant: 'applicant-result.html', admin: 'admin-dashboard.html' };
  api.homeFor = function (role) { return HOME[role] || 'index.html'; };

  /**
   * 로그인·권한을 확인하고, 맞지 않으면 적절한 화면으로 보낸다.
   * roles 를 생략하면 로그인 여부만 본다.
   */
  api.requireRole = async function (roles) {
    var me = await api.me();
    if (!me) {
      location.replace('login.html?next=' + encodeURIComponent(location.pathname.split('/').pop()));
      return new Promise(function () {});      // 이동 중이므로 이후 코드를 멈춘다
    }
    if (roles) {
      var list = Array.isArray(roles) ? roles : [roles];
      if (list.indexOf(me.profile.role) === -1) {
        location.replace(api.homeFor(me.profile.role));
        return new Promise(function () {});
      }
    }
    return me;
  };

  api.onAuthChange = function (fn) {
    sb.auth.onAuthStateChange(function (evt) { _me = null; fn(evt); });
  };

  /* ---------- 대회 · 평가기준 ---------- */

  api.contest = async function () {
    var r = await sb.from('contests').select('*').limit(1).single();
    if (r.error) throw r.error;
    return r.data;
  };

  api.criterionSets = async function (contestId) {
    var r = await sb.from('criterion_sets')
      .select('id,label,is_active,criteria(id,seq,no,short,title,question,max_score)')
      .eq('contest_id', contestId);
    if (r.error) throw r.error;
    r.data.forEach(function (s) { s.criteria.sort(function (a, b) { return a.seq - b.seq; }); });
    return r.data.sort(function (a, b) { return (b.is_active ? 1 : 0) - (a.is_active ? 1 : 0); });
  };

  api.activeCriteria = async function () {
    var r = await sb.from('criterion_sets')
      .select('id,label,criteria(id,seq,no,short,title,question,max_score)')
      .eq('is_active', true).limit(1).single();
    if (r.error) throw r.error;
    r.data.criteria.sort(function (a, b) { return a.seq - b.seq; });
    return r.data;
  };

  /* ---------- 심사위원 ---------- */

  /** 내가 배정받은 지원서 목록 (점수 합계 포함) */
  api.myAssignments = async function () {
    var me = await api.me();
    var r = await sb.from('assignments')
      .select('id,status,submitted_at,team:teams(id,no,name,descr,field,status),scores(score)')
      .eq('judge_id', me.user.id);
    if (r.error) throw r.error;
    return r.data.map(function (a) {
      a.total = a.scores.reduce(function (n, s) { return n + s.score; }, 0);
      a.hasScore = a.scores.length > 0;
      return a;
    }).sort(function (a, b) { return a.team.name.localeCompare(b.team.name, 'ko'); });
  };

  /** 지원서 분석 상세에 필요한 전부 */
  api.teamDetail = async function (teamId) {
    var me = await api.me();

    var t = await sb.from('teams').select('*').eq('id', teamId).single();
    if (t.error) throw t.error;

    var set = await api.activeCriteria();

    var q = await Promise.all([
      sb.from('analyses').select('*').eq('team_id', teamId).order('seq'),
      sb.from('questions').select('*').eq('team_id', teamId).order('seq'),
      sb.from('source_docs').select('*').eq('team_id', teamId).order('seq'),
      sb.from('assignments').select('id,status,comment').eq('team_id', teamId).eq('judge_id', me.user.id).maybeSingle()
    ]);
    q.forEach(function (r) { if (r.error) throw r.error; });

    var assignment = q[3].data;
    var scores = [];
    if (assignment) {
      var s = await sb.from('scores').select('*').eq('assignment_id', assignment.id);
      if (s.error) throw s.error;
      scores = s.data;
    }

    return {
      team: t.data, set: set,
      analyses: q[0].data, questions: q[1].data, docs: q[2].data,
      assignment: assignment, scores: scores
    };
  };

  /** 기준별 점수·사유 저장 (임시저장) */
  api.saveScores = async function (assignmentId, rows) {
    var r = await sb.from('scores').upsert(
      rows.map(function (x) {
        return { assignment_id: assignmentId, criterion_id: x.criterion_id, score: x.score, reason: x.reason || '' };
      }),
      { onConflict: 'assignment_id,criterion_id' }
    );
    if (r.error) throw r.error;
    await sb.from('assignments').update({ status: '진행중' })
      .eq('id', assignmentId).eq('status', '미시작');
    await api.log('score.save', 'assignment:' + assignmentId, { count: rows.length });
  };

  /** 심사 제출 */
  api.submitEvaluation = async function (assignmentId, comment) {
    var r = await sb.from('assignments')
      .update({ status: '완료', comment: comment, submitted_at: new Date().toISOString() })
      .eq('id', assignmentId);
    if (r.error) throw r.error;
    await api.log('evaluation.submit', 'assignment:' + assignmentId, {});
  };

  /* ---------- 지원자 ---------- */

  api.myTeam = async function () {
    var me = await api.me();
    var r = await sb.from('teams').select('*').eq('applicant_id', me.user.id).maybeSingle();
    if (r.error) throw r.error;
    return r.data;
  };

  api.mySummary = async function (teamId) {
    var r = await sb.from('analysis_summaries').select('*').eq('team_id', teamId).order('seq');
    if (r.error) throw r.error;
    return r.data;
  };

  api.teamProgress = async function (teamId) {
    var r = await sb.from('assignments').select('status').eq('team_id', teamId);
    if (r.error) throw r.error;
    return { total: r.data.length, done: r.data.filter(function (a) { return a.status === '완료'; }).length };
  };

  api.myDisputes = async function (teamId) {
    var r = await sb.from('disputes').select('*').eq('team_id', teamId).order('created_at', { ascending: false });
    if (r.error) throw r.error;
    return r.data;
  };

  api.submitDispute = async function (teamId, summaryId, kind, targetText, body, ref) {
    var r = await sb.from('disputes').insert({
      team_id: teamId, summary_id: summaryId, target_kind: kind,
      target_text: targetText, body: body, source_ref: ref || null
    }).select().single();
    if (r.error) throw r.error;
    await api.log('dispute.submit', 'team:' + teamId, { summary_id: summaryId });
    return r.data;
  };

  /* ---------- 운영기관 ---------- */

  api.allTeams = async function () {
    var r = await sb.from('teams')
      .select('*,assignments(id,status,judge_id,scores(score))')
      .order('no');
    if (r.error) throw r.error;
    return r.data;
  };

  api.allJudges = async function () {
    var r = await sb.from('profiles').select('*').eq('role', 'judge').order('code');
    if (r.error) throw r.error;
    return r.data;
  };

  /** 3인 심사가 모두 끝난 팀의 순위 (평균 내림차순) */
  api.ranking = async function () {
    var contest = await api.contest();
    var teams = await api.allTeams();
    var judges = await api.allJudges();
    var byId = {};
    judges.forEach(function (j) { byId[j.id] = j; });

    return teams.map(function (t) {
      var done = t.assignments.filter(function (a) { return a.status === '완료'; });
      var totals = done.map(function (a) {
        return { judge: (byId[a.judge_id] || {}).name || '—',
                 score: a.scores.reduce(function (n, s) { return n + s.score; }, 0) };
      });
      t.scoreList = totals;
      if (totals.length >= contest.per_team_judges) {
        var vals = totals.map(function (x) { return x.score; });
        t.lo = Math.min.apply(null, vals);
        t.hi = Math.max.apply(null, vals);
        t.spread = t.hi - t.lo;
        t.avg = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        t.flagged = t.spread >= contest.flag_spread;
      }
      return t;
    }).filter(function (t) { return t.avg !== undefined; })
      .sort(function (a, b) { return b.avg - a.avg; });
  };

  api.allDisputes = async function () {
    var r = await sb.from('disputes').select('*,team:teams(name)').order('created_at', { ascending: false });
    if (r.error) throw r.error;
    return r.data;
  };

  api.updateDispute = async function (id, status) {
    var r = await sb.from('disputes')
      .update({ status: status, resolved_at: (status === '반영' || status === '기각') ? new Date().toISOString() : null })
      .eq('id', id);
    if (r.error) throw r.error;
    await api.log('dispute.status', 'dispute:' + id, { status: status });
  };

  api.createAssignment = async function (teamId, judgeId) {
    var r = await sb.from('assignments').insert({ team_id: teamId, judge_id: judgeId }).select().single();
    if (r.error) throw r.error;
    await api.log('assignment.create', 'team:' + teamId, { judge_id: judgeId });
    return r.data;
  };

  api.deleteAssignment = async function (id) {
    var r = await sb.from('assignments').delete().eq('id', id);
    if (r.error) throw r.error;
    await api.log('assignment.delete', 'assignment:' + id, {});
  };

  /* ---------- 감사로그 (PRD 8장) ---------- */

  api.log = async function (action, target, detail) {
    try {
      var me = await api.me();
      if (!me) return;
      await sb.from('audit_logs').insert({
        actor_id: me.user.id, action: action, target: target || '', detail: detail || {}
      });
    } catch (e) { /* 로그 실패가 기능을 막지 않도록 */ }
  };

  /* ---------- 공통 UI 헬퍼 ---------- */

  /** 앱 헤더의 사용자 칩을 실제 계정 정보로 채우고 로그아웃을 연결한다 */
  api.mountHeader = async function (me) {
    var nameEl = document.querySelector('.user-chip .name');
    var codeEl = document.querySelector('.user-chip .code');
    var avaEl  = document.querySelector('.user-avatar');
    var p = me.profile;
    if (nameEl) nameEl.textContent = p.name || me.user.email;
    if (codeEl) codeEl.textContent = p.code || me.user.email;
    if (avaEl)  avaEl.textContent = (p.name || 'U').slice(0, 1);

    var out = document.getElementById('signOutBtn');
    if (out) {
      out.addEventListener('click', async function () {
        await api.signOut();
        location.href = 'login.html';
      });
    }
  };

  api.raw = function () { return sb; };

  /* ---------- 초기화 ---------- */
  api.ready = import('https://esm.sh/@supabase/supabase-js@2.45.4')
    .then(function (m) {
      sb = m.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'judix-auth' }
      });
      return api;
    })
    .catch(function (e) {
      console.error('[JudiX] Supabase 로드 실패', e);
      document.addEventListener('DOMContentLoaded', function () {
        var b = document.createElement('div');
        b.style.cssText = 'position:fixed;inset:0;z-index:999;display:grid;place-items:center;' +
          'background:#F7F2E8;color:#231A2B;font-family:system-ui;padding:32px;text-align:center';
        b.innerHTML = '<div style="max-width:520px">' +
          '<h1 style="font-size:22px;margin-bottom:12px">서버에 연결하지 못했습니다</h1>' +
          '<p style="font-size:15px;line-height:1.6;color:#6B6270">' +
          '이 페이지는 웹 서버에서 열어야 합니다. 파일을 더블클릭해 여신 경우' +
          ' <code>file://</code> 제한 때문에 연결이 차단됩니다.<br><br>' +
          '프로젝트 폴더에서 <code>npm start</code> 를 실행한 뒤 ' +
          '<code>http://localhost:4173</code> 으로 접속해 주세요.</p></div>';
        document.body.appendChild(b);
      });
      throw e;
    });

  return api;
})();
