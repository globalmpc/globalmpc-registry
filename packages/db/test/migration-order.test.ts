import { describe, expect, it } from "vitest";
import { listMigrations } from "../src/migrate.js";

/**
 * 마이그레이션 파일 이름 규약 — DB 없이 돈다.
 *
 * **왜 이 파일이 생겼나:** 두 사람이 같은 번호(`0026`)로 마이그레이션을 썼고,
 * 그 사실이 **병합할 때까지 드러나지 않았다.** 각자의 브랜치에서는 파일이 하나씩만
 * 있어 아무 문제가 없었다.
 *
 * 그 상태가 위험한 이유는 파일이 겹쳐서가 아니다 — 파일명이 다르므로 둘 다
 * 적용된다. 위험한 것은 **순서**다. 번호가 곧 적용 순서이므로 같은 번호 둘은
 * 알파벳순이라는 우연에 순서를 맡기게 되고, 한쪽이 다른 쪽의 테이블에 기대면
 * 환경마다 성공과 실패가 갈린다.
 *
 * `runMigrations`는 본문 해시를 대조하므로 **고쳐진** 마이그레이션은 잡는다.
 * 그러나 번호가 겹친 것은 잡지 못한다 — 이름이 다르기 때문이다. 이 파일이 그 자리다.
 */

const NAME_PATTERN = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

describe("마이그레이션 파일 이름", () => {
  const migrations = listMigrations();

  it("적용할 것이 있다", () => {
    // 목록이 비면 아래 검사가 전부 조용히 통과한다.
    expect(migrations.length).toBeGreaterThan(0);
  });

  it("`NNNN_snake_case.sql` 형식을 따른다", () => {
    const wrong = migrations.map((m) => m.name).filter((name) => !NAME_PATTERN.test(name));
    expect(wrong).toEqual([]);
  });

  it("번호가 겹치지 않는다", () => {
    const byNumber = new Map<string, string[]>();
    for (const { name } of migrations) {
      const number = NAME_PATTERN.exec(name)?.[1];
      if (!number) continue;
      byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
    }

    const collisions = [...byNumber.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([number, names]) => `${number}: ${names.join(", ")}`);

    // 겹치면 적용 순서가 알파벳순이라는 우연에 걸린다. 뒤에 쓴 쪽이 번호를 옮긴다.
    expect(collisions).toEqual([]);
  });

  it("번호가 1부터 빈틈없이 이어진다", () => {
    const numbers = migrations
      .map((m) => NAME_PATTERN.exec(m.name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);

    /**
     * 빈틈을 막는 이유: 번호가 비어 있으면 그것이 **아직 안 온 것**인지
     * **지운 것**인지 알 수 없다. 전자라면 병합 뒤에 순서가 뒤집히고, 후자라면
     * 이미 적용한 환경과 새 환경의 스키마가 갈린다.
     */
    const gaps = numbers.filter((n, index) => n !== index + 1);
    expect(gaps).toEqual([]);
  });

  it("파일명 정렬과 번호 정렬이 같다", () => {
    // `runMigrations`는 파일명 오름차순으로 적용한다. 둘이 갈리면 읽은 순서와
    // 실행 순서가 다르다.
    const byName = migrations.map((m) => m.name);
    const byNumber = [...byName].sort(
      (a, b) => Number(NAME_PATTERN.exec(a)?.[1]) - Number(NAME_PATTERN.exec(b)?.[1]),
    );
    expect(byName).toEqual(byNumber);
  });
});
