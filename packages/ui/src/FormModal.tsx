import { useEffect, useState } from 'react';
import { Modal, type ModalProps } from 'antd';

// Hộp thoại biểu mẫu có `confirmLoading` + `forceRender`. Khi lưu xong, `confirmLoading` về false cùng lần vẽ với lúc hộp thoại ẩn
// nên hiệu ứng thu biểu tượng loading của nút Lưu không chạy xong; `forceRender` giữ nguyên nút đó cho lần mở sau và tên truy cập thành "loading Lưu".
// Mỗi lần mở dựng lại chân hộp thoại (key theo số lần mở) để nút Lưu luôn sạch. Truyền `footer` riêng thì dùng đúng chân đó.
export function FormModal(props: ModalProps) {
  const [gen, setGen] = useState(0);
  useEffect(() => { if (props.open) setGen((g) => g + 1); }, [props.open]);
  const own: ModalProps = 'footer' in props ? {} : { footer: (_, { OkBtn, CancelBtn }) => <span key={gen}><CancelBtn /><OkBtn /></span> };
  return <Modal forceRender {...own} {...props} />;
}
