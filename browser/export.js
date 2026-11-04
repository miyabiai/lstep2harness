(async () => {
  "use strict";
  const options = globalThis.LSTEP_EXPORT_OPTIONS || {};
  if (location.origin !== "https://manager.linestep.net") throw new Error("Lステップ管理画面で実行してください");
  if (typeof options.accountId !== "string" || !options.accountId.trim()) {
    throw new Error("LSTEP_EXPORT_OPTIONS.accountId に取得元アカウントの管理番号を指定してください");
  }
  const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const array = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === "string" ? value : "";
  const integer = value => value !== null && value !== "" && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
  const id = value => integer(value) > 0 ? integer(value) : undefined;
  const ids = value => array(value).map(value => id(object(value).id ?? value)).filter(Boolean);
  if (Array.isArray(options.friendIds) && options.friendIds.some(value => !id(value))) {
    throw new Error("friendIds には友だちの管理番号だけを指定してください");
  }
  const unwrap = value => object(value).data && !Array.isArray(value.data) ? object(value.data) : object(value);
  const limit = (value, fallback, maximum) => Math.max(1, Math.min(integer(value) || fallback, maximum));
  const maxPages = limit(options.maxPages, 100, 1000);
  const maxFriends = limit(options.maxFriends, 1000, 100000);
  const interval = Math.max(1100, integer(options.intervalMs) || 1100);
  const output = {
    format: "lstep-browser-v1", account: { id: options.accountId.trim(), label: text(options.accountLabel) },
    exportedAt: new Date().toISOString(),
    data: { friends: [], tags: [], fields: [], templates: [], scenarios: [], forms: [], formResponses: {}, idMappings: { formFields: {}, formSections: {} } },
    coverage: {},
  };
  const coverage = output.coverage;
  const normalizedIds = new Map();
  const formId = (kind, form, value) => {
    const original = typeof value === "number" && id(value) ? String(value) : text(value);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(original)) throw new Error("フォーム部品の識別子が不正です");
    const key = `${form}/${original}`;
    let normalized = id(value);
    if (!normalized) {
      let hash = 14695981039346656037n;
      for (const character of `${kind}:${key}`) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0))) * 1099511628211n);
      normalized = Number(hash & 9007199254740991n) || 1;
    }
    const numericKey = `${kind}:${form}:${normalized}`;
    if (normalizedIds.has(numericKey) && normalizedIds.get(numericKey) !== original) throw new Error("フォーム部品の識別子が衝突しました");
    normalizedIds.set(numericKey, original);
    output.data.idMappings[kind][key] = normalized;
    return normalized;
  };
  let lastRequest = 0;
  let requests = 0;
  const maxRequests = limit(options.maxRequests, 10000, 100000);
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  const knownPath = path => [
    /^\/line\/show\?page=[1-9]\d*$/,
    /^\/api\/(tags|user-vars|templates|content-groups|forms)\?page=[1-9]\d*$/,
    /^\/api\/(templates|content-groups|forms|actions)\/[1-9]\d*$/,
    /^\/api\/forms\/[1-9]\d*\/answers\?page=[1-9]\d*$/,
    /^\/api\/member\/[1-9]\d*\/data$/,
    /^\/api\/member\/var\/[1-9]\d*$/,
    /^\/api\/v1\/message\/timeline\/messages\?pattern=memberDetail&takeNum=50&hasCurrentItems=0&page=[1-9]\d*&viewOptionMode=normal&memberId=[1-9]\d*&detail_view_received=1&detail_view_received_trivial=1&detail_view_received_reactioned=1&detail_view_sent=1&detail_view_system=1&cng=cng(?:&paginateAllCursorId=[A-Za-z0-9%_.~-]+)?$/,
    /^\/api\/v1\/members\/[1-9]\d*\/scenario-status$/,
  ].some(pattern => pattern.test(path));
  const read = async (path, html = false) => {
    if (!knownPath(path)) throw new Error("許可されていない取得先です");
    if (globalThis.LSTEP_EXPORT_CANCEL) throw new Error("取得を中止しました");
    if (requests >= maxRequests) throw new Error("取得回数の上限に達しました");
    // 一時的な混雑（429・5xx・通信断）は間隔を空けて2回まで取り直す。1人の一時エラーで取得全体をやり直さないため
    for (let attempt = 0; ; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, interval * 2 ** attempt - (Date.now() - lastRequest))));
      if (globalThis.LSTEP_EXPORT_CANCEL) throw new Error("取得を中止しました");
      if (requests >= maxRequests) throw new Error("取得回数の上限に達しました");
      lastRequest = Date.now();
      requests += 1;
      let response;
      try {
        response = await fetch(path, {
          method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store",
          headers: {
            Accept: html ? "text/html" : "application/json", "X-Requested-With": "XMLHttpRequest",
            ...(csrf ? { "X-CSRF-TOKEN": csrf } : {}),
          },
        });
      } catch (error) {
        if (attempt < 2) continue;
        throw error;
      }
      if (response.ok) return html ? response.text() : response.json();
      if (attempt < 2 && (response.status === 429 || response.status >= 500)) continue;
      throw new Error(`取得に失敗しました (HTTP ${response.status})`);
    }
  };
  const note = (key, status, count, message) => { coverage[key] = { status, count, note: message }; };
  const downgrade = (key, message) => {
    const previous = coverage[key] || { count: 0 };
    const notes = new Set((previous.note || "").split(" / ").filter(Boolean));
    notes.add(message);
    note(key, "partial", previous.count, [...notes].join(" / "));
  };
  const richText = (value, depth = 0) => {
    if (typeof value === "string") return value;
    if (depth > 16) { downgrade("forms", "見出しの階層が深く一部を取得できませんでした"); return ""; }
    const node = object(value);
    if (node.type === "text") return text(node.text);
    if (node.type === "hardBreak") return "\n";
    return array(node.content).map(child => richText(child, depth + 1)).join(["doc", "bulletList", "orderedList"].includes(node.type) ? "\n" : "");
  };
  const list = async (path, key, convert) => {
    const values = [];
    let complete = false;
    const seen = new Set();
    try {
      for (let page = 1; page <= maxPages; page += 1) {
        const response = object(await read(`${path}?page=${page}`));
        if (!Array.isArray(response.data)) throw new Error("一覧の形式を確認できません");
        for (const entry of response.data) {
          const entryId = id(object(entry).id);
          if (!entryId) { downgrade(key, "管理番号のない項目を除外"); continue; }
          if (seen.has(entryId)) { downgrade(key, "一覧の管理番号が重複"); continue; }
          seen.add(entryId);
          values.push(convert(object(entry)));
        }
        if (integer(response.last_page) >= page && integer(response.current_page) === page) {
          if (page === integer(response.last_page)) { complete = true; break; }
        } else {
          downgrade(key, "ページ数の情報がなく全件取得を確認できません");
          break;
        }
      }
      const previous = coverage[key];
      note(key, complete && !previous ? "complete" : "partial", values.length, previous?.note || (complete ? undefined : "ページ上限に達しました"));
    } catch {
      note(key, values.length ? "partial" : "failed", values.length, "一覧の取得に失敗または中断。未取得があります");
    }
    return values;
  };
  const safeValue = (value, depth = 0) => {
    if (depth > 8) return null;
    if (value === null || ["string", "boolean", "number"].includes(typeof value)) return value;
    if (Array.isArray(value)) return value.map(item => safeValue(item, depth + 1));
    const result = {};
    for (const key of ["value", "values", "date", "time", "label", "text", "url", "fileName", "selected", "others"]) {
      if (key in object(value)) result[key] = safeValue(value[key], depth + 1);
    }
    // 中身はあるのに知っている形がひとつも無い値は、空にして「取得済み」にせず、未対応の印を残す（読み込み側が件数に数えて知らせる）
    if (!Object.keys(result).length && Object.keys(object(value)).length) return { unsupported: true };
    return result;
  };
  if (options.supplement === true) {
    if (!Array.isArray(options.friendIds) || !options.friendIds.length
      || new Set(options.friendIds).size !== options.friendIds.length
      || !Array.isArray(options.visibleFriendIds) || !options.visibleFriendIds.length
      || new Set(options.visibleFriendIds).size !== options.visibleFriendIds.length
      || options.visibleFriendIds.some(value => !id(value) || !options.friendIds.includes(value))
      || !options.visibleFriendIds.includes(options.identityFriendId)) {
      throw new Error("公式APIと管理画面の友だちの照合が必要です");
    }
    const source = unwrap(await read(`/api/member/${options.identityFriendId}/data`));
    if (id(source.id) !== options.identityFriendId) throw new Error("管理画面の応答の管理番号が一致しません");
    output.mode = "supplement";
    output.identity = { memberId: options.identityFriendId, visibleFriendIds: [...options.visibleFriendIds] };
    // 画面側にUIDが返る版だけNodeで追加照合する。公式トークンやUIDを画面へ渡す必要はない。
    if (source.uid !== undefined && source.uid !== null && source.uid !== "") {
      if (typeof source.uid !== "string") throw new Error("管理画面のLINEユーザーIDの形式を確認できません");
      output.identity.uid = source.uid;
    }
  }
  const tag = source => ({ id: id(source.id), name: text(source.name), friend_count: integer(source.member_count ?? source.friend_count ?? source.count) });
  output.data.tags = await list("/api/tags", "tags", tag);
  output.data.fields = await list("/api/user-vars", "fields", source => ({
    id: id(source.id), title: text(source.name ?? source.title),
    type: ({ 0: "TEXT", 2: "TEXTAREA", 20: "SELECT", 30: "DATE", 35: "DATETIME" })[Number(source.type)] || "unsupported",
    options: array(source.options).map(value => ({ label: text(object(value).label ?? object(value).name) })),
  }));
  if (output.data.fields.some(field => field.type === "unsupported")) downgrade("fields", "未対応の友だち情報欄の種類があります");
  if (output.data.fields.some(field => field.type === "SELECT" && !field.options.length)) downgrade("fields", "選択式の友だち情報欄は選択肢が未取得");
  output.data.templates = await list("/api/templates", "templates", source => {
    const content = text(source.content_text);
    // Flex等にもcontent_text（説明文）がある。明示された種類が8以外なら文字本文として扱わない。
    const supported = source.form_type === undefined || Number(source.form_type) === 8;
    if (!content || !supported) downgrade("templates", "本文がないか文字以外のテンプレートがあります");
    return { id: id(source.id), name: text(source.name), type: content && supported ? "text" : "unsupported", content: supported ? content : "" };
  });
  const actionCache = new Map();
  const getActions = async source => {
    const actionId = id(object(source).id ?? source);
    if (!actionId) return [];
    if (actionCache.has(actionId)) return actionCache.get(actionId);
    const result = [];
    try {
      const action = unwrap(await read(`/api/actions/${actionId}`));
      if (!Array.isArray(action.inputs)) downgrade("scenarioActions", "アクションの形式が未確認");
      for (const input of array(action.inputs).map(object)) {
        if (Number(input.type) === 13 && Array.isArray(input.tag_ids)) {
          result.push({ id: actionId, type: "tag", data: { ids: ids(input.tag_ids), action: 1 } });
        } else downgrade("scenarioActions", "タグ追加以外のアクションは未対応");
      }
    } catch { downgrade("scenarioActions", "アクション詳細を取得できませんでした"); actionCache.set(actionId, null); return null; }
    actionCache.set(actionId, result);
    return result;
  };
  note("scenarioActions", "complete", 0);
  const scenarioList = await list("/api/content-groups", "scenarios", source => ({ id: id(source.id), name: text(source.name) }));
  for (const item of scenarioList) {
    const scenario = { ...item, steps: [] };
    try {
      const response = unwrap(await read(`/api/content-groups/${item.id}`));
      const detail = response.content_group ? object(response.content_group) : response;
      if (Object.hasOwn(detail, "date_diff")) {
        downgrade("scenarios", "配信方式・日時（時刻指定・経過時間を含む）の再現は未検証です。本文・ステップは停止状態で取り込み、移行後に配信設定の確認・再設定が必要です");
      }
      const steps = Array.isArray(detail.contents) ? detail.contents : Array.isArray(detail.steps) ? detail.steps : null;
      if (!steps) { downgrade("scenarios", "ステップ一覧の形式が未確認"); scenario.incomplete = true; }
      for (const [index, value] of array(steps).entries()) {
        const step = object(value);
        const stepId = id(step.id);
        if (!stepId) { downgrade("scenarios", "管理番号のないステップを除外"); scenario.incomplete = true; continue; }
        const egg = object(step.egg);
        const templateId = id(egg.template_id ?? egg.templateId ?? (egg.is_template === 1 || egg.is_template === true ? egg.id : undefined));
        const referenced = output.data.templates.find(template => template.id === templateId);
        const inlineText = egg.form_type === undefined || Number(egg.form_type) === 8 ? text(egg.simple) : "";
        if (egg.form_type !== undefined && Number(egg.form_type) !== 8) downgrade("scenarios", "文字以外の配信形式は未対応");
        if (text(egg.simple_image) || text(egg.simple_image_thumb)) downgrade("scenarios", "画像を含むステップは文字部分のみ取得");
        const templates = inlineText ? [{ id: stepId, name: "", type: "text", content: inlineText }] : referenced ? [referenced] : [];
        if (!templates.length) { downgrade("scenarios", "本文が取得できないステップがあります"); scenario.incomplete = true; }
        const initial = step.is_initial === true || step.is_initial === 1;
        const day = integer(step.step);
        const time = text(step.time);
        if (!initial && (day === undefined || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time))) {
          downgrade("scenarios", "配信日時の解釈を確認できないステップがあります");
          scenario.incomplete = true;
        }
        const stepActions = await getActions(step.action);
        if (stepActions === null) scenario.incomplete = true;
        scenario.steps.push({
          id: stepId, name: text(step.name), order_number: index + 1,
          delay_type: initial ? "immediate" : day !== undefined && time ? "date_based" : "unsupported",
          start_day: day, start_time: time || undefined,
          templates, actions: stepActions ?? [],
        });
      }
    } catch { downgrade("scenarios", "シナリオ詳細の取得に失敗しました"); scenario.incomplete = true; }
    // incomplete のシナリオは、移行先のステップを変えない（取れなかったものを「空」として入れない）
    output.data.scenarios.push(scenario);
  }
  coverage.scenarioActions.count = actionCache.size;
  const formList = await list("/api/forms", "forms", source => ({ id: id(source.id), name: text(source.name) }));
  const fieldTypes = new Set(["text", "textarea", "email", "tel", "number", "select", "radio", "checkbox", "date", "heading", "description", "image", "file"]);
  const prefectures = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
    "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
    "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
  ];
  for (const item of formList) {
    const form = { ...item, pages: [] };
    try {
      const detail = unwrap(await read(`/api/forms/${item.id}`));
      form.title = richText(detail.title) || text(object(detail.options).pageTitle);
      form.description = text(detail.description);
      const sections = Array.isArray(detail.sections) ? detail.sections : Array.isArray(object(detail.content).sections) ? detail.content.sections : null;
      if (!sections) { downgrade("forms", "セクション構造が未確認のフォームがあります"); form.incomplete = true; }
      for (const [pageIndex, value] of array(sections).entries()) {
        const section = object(value);
        if (!Array.isArray(section.blocks)) { downgrade("forms", "設問ブロックの構造が未確認"); form.incomplete = true; }
        const fields = [];
        const sectionSourceId = typeof section.id === "number" ? String(section.id) : text(section.id);
        const sectionId = sectionSourceId ? formId("formSections", item.id, section.id) : pageIndex + 1;
        if (!sectionSourceId) { downgrade("forms", "識別子のないセクションがあります"); form.incomplete = true; }
        for (const [position, value] of array(section.blocks).entries()) {
          const block = object(value);
          const blockSourceId = typeof block.id === "number" ? String(block.id) : text(block.id);
          if (!blockSourceId) { downgrade("forms", "識別子のない設問を除外"); form.incomplete = true; continue; }
          const blockId = formId("formFields", item.id, block.id);
          const inputType = text(block.inputType);
          let type = text(block.type);
          if (type === "input") type = ({ SINGLE: "text", MULTI: "textarea", text: "text", textarea: "textarea", email: "email", tel: "tel", phone: "tel", number: "number", date: "date" })[inputType] || "unsupported";
          else if (type === "selection") type = ({ RADIO: "radio", CHECKBOX: "checkbox", DROPDOWN: "select", select: "select", dropdown: "select", radio: "radio", checkbox: "checkbox" })[inputType] || "unsupported";
          else if (type === "prefecture") type = "select";
          if (!fieldTypes.has(type)) downgrade("forms", "未対応の設問種別があります");
          const settings = object(block.settings);
          const choices = block.type === "prefecture" ? prefectures : array(block.items ?? block.options ?? block.choices ?? settings.options ?? settings.items);
          fields.push({
            id: blockId, sourceId: blockSourceId, type: fieldTypes.has(type) ? type : "unsupported", title: richText(block.title ?? block.label),
            help: text(block.desc ?? block.description ?? block.help), position,
            placeholder: block.usePlaceholder === false ? "" : text(block.placeholder),
            rules: { required: block.required === true || object(block.rules).required === true },
            settings: {
              multiple: type === "checkbox" || settings.multiple === true,
              items: choices.map(value => typeof value === "string" ? { label: value, value } : {
                label: text(object(value).name ?? object(value).label ?? object(value).title ?? object(value).text),
                value: text(object(value).valueFriend ?? object(value).value ?? object(value).name ?? object(value).label ?? object(value).title ?? object(value).text),
                tagIds: ids(object(value).valueTagIds ?? object(value).tagIds), friendInfoIds: ids(object(value).friendInfoIds),
                initialState: text(object(value).initialState), initialStateTagIds: ids(object(value).initialStateTagIds),
                useAsOther: object(value).useAsOther === true, useLimit: object(value).useLimit === true,
                destSection: text(object(value).destSection), actionId: id(object(object(value).valueAction).id),
              }),
              friendInfoIds: ids(block.friendInfoIds), tagIds: ids(block.tagIds),
              sourceId: blockSourceId, sourceSectionId: sectionSourceId, inputType,
              sourceType: text(block.type), actionType: text(block.actionType), targetList: array(block.targetList).filter(value => typeof value === "string"),
              hidden: block.hidden === true, useInputRule: block.useInputRule === true, inputRule: text(block.inputRule),
              useInitialValue: block.useInitialValue === true, initialValue: text(block.initialValue),
            },
          });
          if (choices.some(value => ids(object(value).valueTagIds ?? object(value).tagIds).length || ids(object(value).friendInfoIds).length)) {
            downgrade("formBehavior", "選択肢ごとのタグ付与・保存先は未対応");
          }
          if (block.hidden === true || choices.some(value => text(object(value).destSection) || object(value).valueAction || object(value).useLimit || object(value).useAsOther)) {
            downgrade("formBehavior", "非表示部品・条件分岐・選択肢の上限やアクションは未対応");
          }
        }
        form.pages.push({ page_id: sectionId, sourceId: sectionSourceId, fields });
      }
    } catch { downgrade("forms", "フォーム詳細の取得に失敗しました"); form.incomplete = true; }
    // incomplete のフォームは、移行先の設問を変えない（取れなかったものを「設問なし」として入れない）
    output.data.forms.push(form);
    const answers = await list(`/api/forms/${item.id}/answers`, `formResponses_${item.id}`, source => {
      const memberId = id(source.member_id ?? source.memberId ?? object(source.member).id);
      if (!memberId) downgrade(`formResponses_${item.id}`, "友だちの管理番号がない回答を除外");
      const values = array(source.answers);
      if (!Array.isArray(source.answers)) downgrade(`formResponses_${item.id}`, "回答の構造が未確認");
      return {
        id: id(source.id), memberId, answeredAt: text(source.created_at ?? source.answeredAt),
        answers: values.map(value => {
          const answer = object(value);
          return { name: text(answer.name ?? answer.title), type: text(answer.type), value: safeValue(answer.value) };
        }),
      };
    });
    output.data.formResponses[String(item.id)] = answers.filter(answer => answer.memberId);
  }
  const answerCoverage = formList.map(form => coverage[`formResponses_${form.id}`]);
  note("formResponses", answerCoverage.every(item => item.status === "complete") && coverage.forms.status === "complete" ? "complete" : "partial",
    Object.values(output.data.formResponses).reduce((sum, values) => sum + values.length, 0),
    answerCoverage.every(item => item.status === "complete") ? undefined : "未取得・未対応の回答があります");
  downgrade("formBehavior", "設問ごとの保存先・条件分岐・回答後動作の移行は要確認");
  const readScenarios = async memberId => {
    const status = unwrap(await read(`/api/v1/members/${memberId}/scenario-status`));
    if (Array.isArray(status.scenarios)) {
      const values = status.scenarios.map(object);
      if (values.some(value => !id(value.id)) || new Set(values.map(value => id(value.id))).size !== values.length) {
        downgrade("friendScenarios", "購読シナリオの管理番号が不正または重複しています");
        return null;
      }
      return values.map(state => ({ id: id(state.id), name: text(state.name), status: text(state.status), started_at: text(state.started_at) }));
    }
    const keys = ["reading_scenario", "next_scenario", "previous_scenario", "past_scenarios"];
    const empty = value => value === null || value === "" || Array.isArray(value) && value.length === 0
      || value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
    if (keys.every(key => Object.hasOwn(status, key) && empty(status[key]))) return [];
    downgrade("friendScenarios", "空ではない購読状況の構造が未確認");
    return null;
  };
  if (options.supplement === true) {
    note("friendScenarios", "complete", 0);
    for (const memberId of options.friendIds.slice(0, maxFriends)) {
      try {
        const scenarios = await readScenarios(memberId);
        if (scenarios !== null) {
          output.data.friends.push({ id: memberId, scenarios });
          coverage.friendScenarios.count += scenarios.length;
        }
      } catch { downgrade("friendScenarios", "購読状況を取得できませんでした"); }
      if (globalThis.LSTEP_EXPORT_CANCEL || requests >= maxRequests) break;
    }
    if (output.data.friends.length !== options.friendIds.length) {
      downgrade("friendScenarios", "上限・未対応・中断により購読状況を補完できない友だちがあります。公式APIの友だちは保持します");
    }
    globalThis.LSTEP_LAST_EXPORT = output;
    console.info("Lステップ設定補完終了", { friends: output.data.friends.length, requests, coverage });
    return output;
  }
  const memberIds = [];
  const seenMembers = new Set();
  if (Array.isArray(options.friendIds)) {
    for (const value of options.friendIds) {
      const memberId = id(value);
      if (!memberId) throw new Error("friendIds には友だちの管理番号だけを指定してください");
      if (!seenMembers.has(memberId)) { seenMembers.add(memberId); memberIds.push(memberId); }
    }
    note("friends", "partial", memberIds.length, "指定された管理番号だけを取得。全友だちとの照合は別途必要");
  } else {
    let complete = false;
    try {
      for (let page = 1; page <= maxPages; page += 1) {
        const html = await read(`/line/show?page=${page}`, true);
        const parsed = new DOMParser().parseFromString(html, "text/html");
        const links = [...parsed.querySelectorAll("a[href]")];
        let newCount = 0;
        for (const link of links) {
          const url = new URL(link.getAttribute("href"), location.origin);
          if (url.origin !== location.origin) continue;
          const match = url.pathname.match(/^\/line\/detail\/([1-9]\d*)$/);
          if (match && !seenMembers.has(Number(match[1]))) {
            seenMembers.add(Number(match[1])); memberIds.push(Number(match[1])); newCount += 1;
          }
        }
        const pages = links.map(link => new URL(link.getAttribute("href"), location.origin))
          .filter(url => url.origin === location.origin && url.pathname === "/line/show")
          .map(url => integer(url.searchParams.get("page"))).filter(Boolean);
        if (!pages.some(value => value > page)) {
          complete = Boolean(parsed.querySelector('.pagination, [role="navigation"][aria-label*="agination"]'));
          break;
        }
        if (!newCount || memberIds.length >= maxFriends) break;
      }
      note("friends", complete ? "complete" : "partial", memberIds.length, complete ? undefined : "HTMLの総ページ数または上限を確認してください");
    } catch { note("friends", memberIds.length ? "partial" : "failed", memberIds.length, "友だち一覧の取得に失敗または中断"); }
  }
  if (!memberIds.length) downgrade("friends", "友だちの管理番号を取得できませんでした。移行画面の友だち一覧の読み取りからやり直してください");
  if (memberIds.length > maxFriends) downgrade("friends", "友だち取得件数の上限に達しました");
  note("friendTags", "complete", 0);
  note("friendFields", "complete", 0);
  note("friendScenarios", "complete", 0);
  note("conversations", "complete", 0);
  note("systemEvents", "complete", 0, "システム通知は会話から除外");
  for (const memberId of memberIds.slice(0, maxFriends)) {
    let source;
    try { source = unwrap(await read(`/api/member/${memberId}/data`)); }
    catch { downgrade("friends", "取得できない友だちがあります"); continue; }
    if (!/^U[0-9a-f]{32}$/i.test(text(source.uid))) {
      downgrade("friends", `管理番号 ${memberId} のLINEユーザーIDが未取得。表示名では照合しません`);
      continue;
    }
    if (id(source.id) !== memberId) { downgrade("friends", "応答の管理番号が一致しないため除外"); continue; }
    const friend = {
      id: memberId, uid: source.uid, name: text(source.name),
      isBlocked: typeof source.isBlocked === "boolean" ? source.isBlocked : source.isBlocked === 1 ? true : source.isBlocked === 0 ? false : undefined,
      createdAt: text(source.createdAt),
      tags: array(source.tags).map(object).filter(value => id(value.id)).map(tag),
      fields: array(source.friendInfo).map(object).filter(value => id(value.id)).map(field => ({
        id: id(field.id), name: text(field.name), value: safeValue(field.value),
      })), scenarios: [], timeline: { messages: [], complete: false },
    };
    if (!Array.isArray(source.tags)) downgrade("friendTags", "友だちごとのタグは未取得");
    try {
      const variables = unwrap(await read(`/api/member/var/${memberId}`));
      if (!variables.values || typeof variables.values !== "object" || Array.isArray(variables.values)) {
        downgrade("friendFields", "友だち情報の値の形式が未確認");
      } else {
        const fieldsById = new Map(friend.fields.map(field => [field.id, field]));
        for (const [fieldId, value] of Object.entries(variables.values)) {
          if (!/^[1-9]\d*$/.test(fieldId)) { downgrade("friendFields", "識別子が不正な友だち情報の値を除外"); continue; }
          const definition = output.data.fields.find(field => field.id === id(fieldId));
          if (!definition) { downgrade("friendFields", "定義が未取得の友だち情報の値を除外"); continue; }
          if (typeof value !== "string") { downgrade("friendFields", "文字列以外の友だち情報の値は未対応"); continue; }
          fieldsById.set(definition.id, { id: definition.id, name: definition.title, value });
        }
        friend.fields = [...fieldsById.values()];
      }
    } catch { downgrade("friendFields", "友だち情報の値を取得できませんでした"); }
    coverage.friendTags.count += friend.tags.length;
    coverage.friendFields.count += friend.fields.length;
    try {
      friend.scenarios = await readScenarios(memberId) ?? [];
    } catch { downgrade("friendScenarios", "購読状況を取得できませんでした"); }
    coverage.friendScenarios.count += friend.scenarios.length;
    const messageIds = new Set();
    let cursor;
    let timelineParsed = true;
    try {
      for (let page = 1; page <= maxPages; page += 1) {
        const suffix = cursor ? `&paginateAllCursorId=${encodeURIComponent(cursor)}` : "";
        const timeline = unwrap(await read(`/api/v1/message/timeline/messages?pattern=memberDetail&takeNum=50&hasCurrentItems=0&page=${page}&viewOptionMode=normal&memberId=${memberId}&detail_view_received=1&detail_view_received_trivial=1&detail_view_received_reactioned=1&detail_view_sent=1&detail_view_system=1&cng=cng${suffix}`));
        const messages = Array.isArray(timeline.messages) ? timeline.messages : null;
        if (!messages) { downgrade("conversations", "会話の一覧構造が未確認"); break; }
        let newCount = 0;
        for (const value of messages) {
          const message = object(value);
          const messageId = id(message.id);
          if (messageId && messageIds.has(messageId)) continue;
          if (messageId) messageIds.add(messageId);
          newCount += 1;
          if (message.fromSystem === true) { coverage.systemEvents.count += 1; continue; }
          if (message.fromSystem !== false || typeof message.fromOwner !== "boolean") {
            downgrade("conversations", "送受信方向またはシステム通知の判定が未確認のメッセージを除外");
            timelineParsed = false;
            continue;
          }
          const content = text(message.contentText);
          const media = text(message.contentMedia);
          if (!content && !media) { downgrade("conversations", "本文の形式が未対応のメッセージがあります"); timelineParsed = false; continue; }
          if (media) downgrade("conversations", "メディアはURLのみ保存。種類の判定・実ファイルの移行は未対応");
          const sentAt = text(message.time ?? message.createdAt ?? message.created_at ?? message.sentAt);
          if (!sentAt) downgrade("conversations", "送信日時が未取得のメッセージがあります");
          friend.timeline.messages.push({
            message_id: messageId, sender: message.fromOwner ? "bot" : "friend",
            message_type: content ? "text" : "unsupported", content: content && media ? `${content}\n${media}` : content || media,
            sent_at: sentAt,
          });
        }
        if (array(timeline.futureMessages).length || array(timeline.sendingMessages).length) downgrade("conversations", "未来の送信予約・送信待ちメッセージは未対応");
        if (timeline.paginateHasNext === false) { friend.timeline.complete = timelineParsed; break; }
        if (timeline.paginateHasNext !== true || !newCount) break;
        const next = timeline.paginateAllCursorId;
        cursor = typeof next === "string" || typeof next === "number" ? String(next) : undefined;
      }
    } catch { downgrade("conversations", "会話の取得に失敗または中断しました"); }
    if (!friend.timeline.complete) downgrade("conversations", "全件を取得できない会話があります");
    coverage.conversations.count += friend.timeline.messages.length;
    output.data.friends.push(friend);
  }
  coverage.friends.count = output.data.friends.length;
  if (!output.data.friends.length) {
    downgrade("friends", "友だちの取得は0人です。設定データだけを保存しました");
    console.warn("友だちの取得は0人です。設定データの取得結果だけを保存します。");
  }
  if (coverage.friends.status !== "complete") {
    for (const key of ["friendTags", "friendFields", "friendScenarios", "conversations"]) {
      downgrade(key, "友だち一覧に未取得の可能性があります");
    }
  }
  for (const key of ["handlingStatuses", "autoReplies", "welcomeMessages", "richMenus", "trafficSources"]) {
    note(key, "unsupported", 0, "この画面取得版では未対応");
  }
  globalThis.LSTEP_LAST_EXPORT = output;
  console.info("Lステップ取得終了", { friends: output.data.friends.length, requests, coverage });
  return output;
})();
