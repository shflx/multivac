import type { SVGProps } from 'react';

/** 品牌标识只用于代表 Multivac，功能与状态图标继续使用各自的语义图标。 */
export function MultivacIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <use href={`${import.meta.env.BASE_URL}multivac.svg#mark`} />
    </svg>
  );
}
